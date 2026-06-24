#!/usr/bin/env python3
"""Orchestrate the asndb data pipeline.

Downloads the latest BGP RIB, converts it to .dat and .json formats, and
publishes everything to the asndb Worker, which stores the files in R2,
updates the KV 'latest' pointer, and prunes old snapshots.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from ftplib import FTP
from pathlib import Path
from urllib.request import urlopen

import requests
from pyasn import mrtx

ASNAMES_URL = 'http://www.cidr-report.org/as2.0/autnums.html'
ASNAME_LINE_RE = re.compile(r'<a .+>AS(?P<code>.+?)\s*</a>\s*(?P<name>.*)', re.U)

# Default socket timeout for FTP control/data connections. This guards against
# stalled RouteViews archive downloads where the control channel stays open but
# no data is transferred. Can be overridden via the --ftp-timeout flag or the
# FTP_TIMEOUT environment variable.
FTP_TIMEOUT_DEFAULT = int(os.environ.get('FTP_TIMEOUT', '300'))


def _find_latest_rib(
    server: str = 'archive.routeviews.org',
    archive_root: str = 'route-views4/bgpdata',
    sub_dir: str = 'RIBS',
    timeout: int = FTP_TIMEOUT_DEFAULT,
) -> tuple[str, str, str]:
    """Return (server, remote_dir, filename) for the latest RIB archive."""
    print(f'Finding latest RIB archive on ftp://{server}')
    with FTP(server, timeout=timeout) as ftp:
        ftp.login()
        months = sorted(ftp.nlst(archive_root), reverse=True)
        for month in months:
            remote_dir = f'/{month}/{sub_dir}'
            try:
                ftp.cwd(remote_dir)
                filenames = ftp.nlst()
            except Exception:
                continue
            if filenames:
                return server, remote_dir, max(filenames)
    raise RuntimeError('Could not find a recent RIB archive to download')


def _ftp_download(
    server: str,
    remote_dir: str,
    remote_file: str,
    local_file: Path,
    timeout: int = FTP_TIMEOUT_DEFAULT,
) -> None:
    """Download a file from an FTP server."""
    print(f'Downloading ftp://{server}{remote_dir}/{remote_file}')
    with FTP(server, timeout=timeout) as ftp:
        ftp.login()
        ftp.cwd(remote_dir)
        with local_file.open('wb') as fp:
            ftp.retrbinary(f'RETR {remote_file}', fp.write)
    print('Download complete.')


def download_rib(tmp_dir: Path, timeout: int = FTP_TIMEOUT_DEFAULT) -> Path:
    """Download the latest RouteViews RIB dump."""
    print('Downloading latest RIB dump')
    server, remote_dir, filename = _find_latest_rib(timeout=timeout)
    local_file = tmp_dir / filename
    _ftp_download(server, remote_dir, filename, local_file, timeout=timeout)
    return local_file


def _origin_as_to_int(origin: int | set[int]) -> int:
    """Return an integer ASN from pyasn's origin (which may be a set)."""
    if isinstance(origin, set):
        return list(origin)[0]
    return origin


def _has_bgpdump() -> bool:
    """Return True if the bgpdump binary is available."""
    try:
        subprocess.run(
            ['bgpdump', '-v'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


def _parse_bgpdump_line(line: str) -> tuple[str, int] | None:
    """Parse a bgpdump -m line into (prefix, origin_as)."""
    parts = line.strip().split('|')
    if len(parts) < 8 or parts[0] != 'TABLE_DUMP2':
        return None

    prefix = parts[5].strip()
    origin = parts[7].strip()
    if not prefix or not origin:
        return None

    # Validate prefix looks like a CIDR.
    if '/' not in prefix:
        return None

    try:
        return prefix, int(origin)
    except ValueError:
        return None


def _convert_rib_to_dat_with_bgpdump(rib_file: Path, dat_file: Path) -> None:
    """Convert a RIB dump to .dat using bgpdump (faster, lower memory)."""
    print(f'Converting {rib_file.name} to {dat_file.name} via bgpdump')

    v4 = 0
    v6 = 0
    with dat_file.open('w', encoding='ascii') as out:
        out.write('; IP-ASN32-DAT file\n')
        out.write(f'; Original source: {rib_file.name}\n')

        process = subprocess.Popen(
            ['bgpdump', '-m', '-O', '-', str(rib_file)],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )

        assert process.stdout is not None
        for line in process.stdout:
            parsed = _parse_bgpdump_line(line)
            if parsed is None:
                continue

            prefix, origin = parsed
            if prefix in ('0.0.0.0/0', '::/0'):
                continue

            out.write(f'{prefix}\t{origin}\n')
            if ':' in prefix:
                v6 += 1
            else:
                v4 += 1

        process.wait()
        if process.returncode != 0:
            raise RuntimeError(f'bgpdump failed with code {process.returncode}')

    print(f'IPASN database saved ({v4} IPV4 + {v6} IPV6 prefixes)')


def _convert_rib_to_dat_with_pyasn(rib_file: Path, dat_file: Path) -> None:
    """Convert a RIB dump to a pyasn .dat file using streaming MRT parsing."""
    print(f'Converting {rib_file.name} to {dat_file.name} via pyasn')

    v4 = 0
    v6 = 0
    with mrtx.open_archive(str(rib_file)) as handle, dat_file.open(
        'w', encoding='ascii'
    ) as out:
        out.write('; IP-ASN32-DAT file\n')
        out.write(f'; Original source: {rib_file.name}\n')

        while True:
            record = mrtx.MrtRecord.next_dump_table_record(handle)
            if record is None:
                break

            if (
                not record.detail
                or (
                    record.type == mrtx.MrtRecord.TYPE_TABLE_DUMP_V2
                    and record.sub_type == mrtx.MrtRecord.T2_PEER_INDEX
                )
            ):
                continue

            prefix = record.prefix
            if prefix in ('0.0.0.0/0', '::/0'):
                continue

            try:
                origin = _origin_as_to_int(record.get_first_origin_as())
            except (IndexError, ValueError):
                continue

            out.write(f'{prefix}\t{origin}\n')
            if ':' in prefix:
                v6 += 1
            else:
                v4 += 1

    print(f'IPASN database saved ({v4} IPV4 + {v6} IPV6 prefixes)')


def convert_rib_to_dat(rib_file: Path, dat_file: Path) -> None:
    """Convert a RIB dump to a .dat file.

    Uses bgpdump if available for speed, otherwise falls back to pyasn's
    streaming MRT parser.
    """
    if _has_bgpdump():
        _convert_rib_to_dat_with_bgpdump(rib_file, dat_file)
    else:
        _convert_rib_to_dat_with_pyasn(rib_file, dat_file)


def convert_dat_to_json(dat_file: Path, json_file: Path) -> None:
    """Convert a pyasn .dat file to sorted JSON using external sort.

    This avoids loading the entire prefix table into memory.
    """
    print(f'Converting {dat_file.name} to {json_file.name}')
    sorted_dat = dat_file.with_suffix('.sorted')

    try:
        with sorted_dat.open('w', encoding='utf-8') as sort_output:
            subprocess.run(
                ['sort', str(dat_file)],
                stdout=sort_output,
                check=True,
                text=True,
            )

        with sorted_dat.open('r', encoding='utf-8') as handle, json_file.open(
            'w', encoding='utf-8'
        ) as out:
            out.write('{')
            first = True
            previous_prefix: str | None = None
            for line in handle:
                line = line.strip()
                if not line or line.startswith(';'):
                    continue

                # Lines look like: 1.0.0.0/24\t15169
                parts = line.split('\t')
                if len(parts) != 2:
                    continue

                prefix, asn = parts
                prefix = prefix.strip()
                try:
                    asn_int = int(asn.strip())
                except ValueError:
                    continue

                # The .dat file may contain duplicate prefixes; keep the first
                # sorted occurrence and skip the rest.
                if prefix == previous_prefix:
                    continue
                previous_prefix = prefix

                if not first:
                    out.write(',')
                first = False
                out.write(f'{json.dumps(prefix)}:{asn_int}')

            out.write('}')
    finally:
        if sorted_dat.exists():
            sorted_dat.unlink()


def _html_to_asnames(data: str) -> dict[str, str]:
    """Parse cidr-report AS names HTML into an ASN -> name mapping."""
    mapping: dict[str, str] = {}
    for line in data.splitlines():
        if not line.startswith('<a'):
            continue
        match = ASNAME_LINE_RE.match(line)
        if not match:
            continue
        code, name = match.groups()
        mapping[code.strip()] = name.strip()
    return mapping


def download_asnames(json_file: Path) -> None:
    """Download the AS names database from cidr-report."""
    print('Downloading AS names database')
    with urlopen(ASNAMES_URL, timeout=60) as response:
        data = response.read().decode('latin-1')

    mapping = _html_to_asnames(data)
    with json_file.open('w', encoding='utf-8') as handle:
        json.dump(mapping, handle, sort_keys=True)


def get_content_type(filename: str) -> str:
    """Return the HTTP content type for a generated file."""
    if filename.endswith('.dat'):
        return 'application/octet-stream'
    return 'application/json'


def upload_file_to_worker(
    prefix: str,
    filename: str,
    path: Path,
    endpoint: str,
    token: str,
) -> None:
    """Upload a single file to the asndb Worker for storage in R2."""
    url = f'{endpoint.rstrip("/")}/{prefix}/{filename}'
    print(f'Uploading {filename} to {url}')
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': get_content_type(filename),
    }

    with path.open('rb') as handle:
        response = requests.post(url, data=handle, headers=headers, timeout=300)
        response.raise_for_status()

    print(f'  uploaded {filename}: {response.text}')


def _publish_url(endpoint: str, prefix: str) -> str:
    """Derive the publish URL from the upload endpoint.

    The upload endpoint is expected to end in /upload (e.g.
    https://asndb.network/upload). The publish endpoint replaces that
    trailing /upload with /publish.
    """
    base = endpoint.rstrip('/')
    if base.endswith('/upload'):
        publish_base = base[:-len('/upload')] + '/publish'
    else:
        publish_base = base + '/publish'
    return f'{publish_base}/{prefix}'


def publish_to_worker(
    prefix: str,
    endpoint: str,
    token: str,
) -> None:
    """Tell the asndb Worker to update KV latest and clean old snapshots."""
    url = _publish_url(endpoint, prefix)
    print(f'Publishing {prefix}')
    headers = {'Authorization': f'Bearer {token}'}

    response = requests.post(url, headers=headers, timeout=60)
    response.raise_for_status()

    print(f'  published: {response.text}')


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description='Download BGP data, convert it, and publish to asndb.'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Generate files locally but do not upload',
    )
    parser.add_argument(
        '--skip-upload',
        action='store_true',
        help='Skip uploading files to the asndb Worker',
    )
    parser.add_argument(
        '--rib-file',
        type=Path,
        help='Use an existing RIB file instead of downloading one',
    )
    parser.add_argument(
        '--keep-tmp',
        action='store_true',
        help='Do not delete the temporary working directory on exit',
    )
    parser.add_argument(
        '--tmp-dir',
        type=Path,
        help='Directory to use for temporary files (defaults to system temp)',
    )
    parser.add_argument(
        '--ftp-timeout',
        type=int,
        default=FTP_TIMEOUT_DEFAULT,
        help='Socket timeout in seconds for FTP operations (default: %(default)s)',
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    dry_run = args.dry_run

    needs_upload = not dry_run and not args.skip_upload

    required: list[str] = []
    if needs_upload:
        required.extend(['UPLOAD_ENDPOINT', 'UPLOAD_TOKEN'])

    missing = [var for var in required if not os.environ.get(var)]
    if missing:
        print(
            f'Error: missing environment variables: {", ".join(missing)}',
            file=sys.stderr,
        )
        return 1

    upload_endpoint = os.environ.get('UPLOAD_ENDPOINT', '')
    upload_token = os.environ.get('UPLOAD_TOKEN', '')

    # Prefix like 20250621/2000
    prefix = datetime.now(timezone.utc).strftime('%Y%m%d/%H00')

    tmp_dir = args.tmp_dir
    if tmp_dir is not None:
        tmp_dir.mkdir(parents=True, exist_ok=True)

    tmp_dir_ctx = (
        tempfile.TemporaryDirectory(prefix='asndb-', dir=tmp_dir)
        if not args.keep_tmp
        else contextlib.nullcontext(
            tempfile.mkdtemp(prefix='asndb-', dir=tmp_dir)
        )
    )

    with tmp_dir_ctx as tmp:
        tmp_dir = Path(tmp)

        if args.rib_file:
            rib_file = args.rib_file
        else:
            rib_file = download_rib(tmp_dir, timeout=args.ftp_timeout)

        dat_file = tmp_dir / 'ip.dat'
        convert_rib_to_dat(rib_file, dat_file)

        ip_json_file = tmp_dir / 'ip.json'
        convert_dat_to_json(dat_file, ip_json_file)

        asn_json_file = tmp_dir / 'asn.json'
        download_asnames(asn_json_file)

        files = {
            'ip.dat': dat_file,
            'ip.json': ip_json_file,
            'asn.json': asn_json_file,
        }

        if dry_run or args.skip_upload:
            print(
                f'{"Would upload" if dry_run else "Skipping upload of"} {len(files)} file(s) to {upload_endpoint or "<endpoint>"}/{prefix}'
            )
            for name in files:
                print(f'  {prefix}/{name}')
            print(f'{"Would publish" if dry_run else "Skipping publish of"} {prefix}')
        else:
            for name, path in files.items():
                upload_file_to_worker(
                    prefix, name, path, upload_endpoint, upload_token
                )
            publish_to_worker(prefix, upload_endpoint, upload_token)

    if args.keep_tmp:
        print(f'Keeping temporary directory: {tmp_dir}')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())

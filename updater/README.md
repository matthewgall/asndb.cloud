# asndb.network updater

This directory contains the Python updater that downloads the latest BGP RIB, converts it into `.dat` and `.json` formats, and pushes the files to the asndb Worker.

## Deployment

### 1. Copy files to the server

```bash
sudo mkdir -p /opt/asndb/updater
sudo cp update.py requirements.txt /opt/asndb/updater/
```

### 2. Create a dedicated user

```bash
sudo useradd --system --home-dir /opt/asndb --shell /usr/sbin/nologin asndb
```

### 3. Create a virtual environment and install dependencies

```bash
sudo python3 -m venv /opt/asndb/updater/.venv
sudo /opt/asndb/updater/.venv/bin/pip install -r /opt/asndb/updater/requirements.txt
```

### 4. Configure secrets

Create `/etc/asndb/updater.env` containing the upload token:

```bash
UPLOAD_TOKEN=your-upload-token-here
```

Set restrictive permissions:

```bash
sudo chmod 600 /etc/asndb/updater.env
```

`UPLOAD_ENDPOINT` is set in the systemd unit file but can be overridden in the env file if needed.

### 5. Install the systemd timer

```bash
sudo cp asndb-updater.service asndb-updater.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now asndb-updater.timer
```

### 6. Verify

Check the timer status:

```bash
sudo systemctl list-timers asndb-updater.timer
```

Run a manual dry-run to confirm everything works:

```bash
sudo -u asndb /opt/asndb/updater/.venv/bin/python /opt/asndb/updater/update.py --dry-run --keep-tmp
```

If `/tmp` is too small (RIB + output files can exceed a few hundred MB), point the temporary directory elsewhere:

```bash
sudo mkdir -p /var/tmp/asndb
sudo -u asndb /opt/asndb/updater/.venv/bin/python /opt/asndb/updater/update.py --dry-run --keep-tmp --tmp-dir /var/tmp/asndb
```

## Options

- `--dry-run` — download and convert locally, but do not upload or publish.
- `--skip-upload` — convert files but skip uploading to the Worker.
- `--rib-file PATH` — use an existing RIB file instead of downloading.
- `--keep-tmp` — do not delete the temporary working directory on exit.
- `--tmp-dir PATH` — use a specific directory for temporary files instead of the system default (`/tmp`). Useful when `/tmp` is too small.

import { AutoRouter, IRequest } from 'itty-router'

type WorkerArgs = [Env, ExecutionContext]
type WorkerRequest = IRequest & Request

const NOT_FOUND_MESSAGE = 'We were unable to find data for that timeframe'
const RETENTION_DAYS = 14
const UPLOADABLE_FILES = ['ip.dat', 'ip.json', 'asn.json']

function getContentType(filename: string): string {
    return filename.includes('.dat')
        ? 'application/octet-stream'
        : 'application/json'
}

function isValidPrefix(prefix: string): boolean {
    return /^\d{8}\/\d{4}$/.test(prefix)
}

function isValidFilename(filename: string): boolean {
    return UPLOADABLE_FILES.includes(filename)
}

function parseSnapshotPrefix(key: string): Date | null {
    const parts = key.split('/')
    if (parts.length < 2) {
        return null
    }
    const date = parts[0]
    const hour = parts[1]
    if (date.length !== 8 || hour.length !== 4) {
        return null
    }
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${hour.slice(0, 2)}:00:00Z`
    const parsed = new Date(iso)
    return isNaN(parsed.getTime()) ? null : parsed
}

type CleanupResult = {
    deletedSnapshots: string[]
    deletedKeys: number
}

async function cleanupOldSnapshots(bucket: R2Bucket): Promise<CleanupResult> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)

    const prefixKeys = new Map<string, string[]>()
    let cursor: string | undefined

    do {
        const list = await bucket.list({ cursor })
        for (const object of list.objects) {
            const snapshotDt = parseSnapshotPrefix(object.key)
            if (!snapshotDt || snapshotDt >= cutoff) {
                continue
            }
            const prefix = object.key.split('/').slice(0, 2).join('/')
            const keys = prefixKeys.get(prefix) || []
            keys.push(object.key)
            prefixKeys.set(prefix, keys)
        }
        cursor = list.truncated ? list.cursor : undefined
    } while (cursor)

    const deletedSnapshots: string[] = []
    let deletedKeys = 0

    if (prefixKeys.size) {
        const sorted = Array.from(prefixKeys.entries()).sort(([a], [b]) =>
            a.localeCompare(b)
        )
        for (const [prefix, keys] of sorted) {
            await bucket.delete(keys)
            deletedSnapshots.push(prefix)
            deletedKeys += keys.length
        }
    }

    return { deletedSnapshots, deletedKeys }
}

function checkAuthorization(request: WorkerRequest, env: Env): Response | null {
    const authorization = request.headers.get('Authorization')
    const expected = `Bearer ${env.UPLOAD_TOKEN}`
    if (authorization !== expected) {
        return new Response('unauthorized', {
            status: 401,
            headers: { 'Content-Type': 'text/plain' },
        })
    }
    return null
}

async function getDataHandler(
    request: WorkerRequest,
    env: Env
): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const resource = path.replace('/get/', '')
    const resourceInfo = resource.split('/')
    const pointerSegment = resourceInfo[0]
    const filename = resourceInfo[1]

    if (!pointerSegment || !filename) {
        return new Response(NOT_FOUND_MESSAGE, {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
        })
    }

    const pointer =
        pointerSegment === 'latest'
            ? await env.asndb.get('latest')
            : `${pointerSegment}/0000`

    if (!pointer) {
        return new Response(NOT_FOUND_MESSAGE, {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
        })
    }

    const object = await env.R2.get(`${pointer}/${filename}`)

    if (!object) {
        return new Response(NOT_FOUND_MESSAGE, {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
        })
    }

    return new Response(object.body, {
        headers: { 'Content-Type': getContentType(filename) },
    })
}

async function uploadFileHandler(
    request: WorkerRequest,
    env: Env
): Promise<Response> {
    const authError = checkAuthorization(request, env)
    if (authError) {
        return authError
    }

    const date = request.params?.date
    const hour = request.params?.hour
    const filename = request.params?.filename
    const prefix = date && hour ? `${date}/${hour}` : null
    if (!prefix || !isValidPrefix(prefix) || !isValidFilename(filename)) {
        return new Response('invalid or missing prefix/filename', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' },
        })
    }

    if (!request.body) {
        return new Response('missing body', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' },
        })
    }

    await env.R2.put(`${prefix}/${filename}`, request.body, {
        httpMetadata: { contentType: getContentType(filename) },
    })

    return new Response(JSON.stringify({ ok: true, prefix, filename }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    })
}

async function publishHandler(
    request: WorkerRequest,
    env: Env
): Promise<Response> {
    const authError = checkAuthorization(request, env)
    if (authError) {
        return authError
    }

    const date = request.params?.date
    const hour = request.params?.hour
    const prefix = date && hour ? `${date}/${hour}` : null
    if (!prefix || !isValidPrefix(prefix)) {
        return new Response('invalid or missing prefix', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' },
        })
    }

    await env.asndb.put('latest', prefix)
    await cleanupOldSnapshots(env.R2)

    return new Response(JSON.stringify({ ok: true, prefix, published: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    })
}

async function cleanupHandler(
    request: WorkerRequest,
    env: Env
): Promise<Response> {
    const authError = checkAuthorization(request, env)
    if (authError) {
        return authError
    }

    try {
        const result = await cleanupOldSnapshots(env.R2)
        return new Response(
            JSON.stringify({
                ok: true,
                retentionDays: RETENTION_DAYS,
                ...result,
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }
        )
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'cleanup failed'
        return new Response(JSON.stringify({ ok: false, error: message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        })
    }
}

async function assetsHandler(
    request: WorkerRequest,
    env: Env
): Promise<Response> {
    const response = await env.ASSETS.fetch(request.url)

    if (response.status === 404) {
        return new Response('resource not found', {
            status: 404,
            statusText: 'not found',
            headers: { 'content-type': 'text/plain' },
        })
    }

    return response
}

const router = AutoRouter<WorkerRequest, WorkerArgs>()

router
    .get('/get/*', getDataHandler)
    .post('/upload/:date/:hour/:filename', uploadFileHandler)
    .post('/publish/:date/:hour', publishHandler)
    .post('/cleanup', cleanupHandler)
    .all('*', assetsHandler)

export default { ...router }

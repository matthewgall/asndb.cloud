import { AutoRouter, IRequest } from 'itty-router'

type WorkerArgs = [Env, ExecutionContext]
type WorkerRequest = IRequest & Request

const NOT_FOUND_MESSAGE = 'We were unable to find data for that timeframe'

async function fetchFromS3(
    env: Env,
    pointer: string,
    filename: string
): Promise<Response> {
    const upstream = `${env.S3_ENDPOINT}/${env.S3_BUCKET}/${pointer}/${filename}`
    return fetch(upstream)
}

function getContentType(filename: string): string {
    return filename.includes('.dat')
        ? 'application/octet-stream'
        : 'application/json'
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

    const upstream = await fetchFromS3(env, pointer, filename)

    if (upstream.status !== 200) {
        return new Response(NOT_FOUND_MESSAGE, {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
        })
    }

    const data = await upstream.text()
    return new Response(data, {
        headers: { 'Content-Type': getContentType(filename) },
    })
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

router.get('/get/*', getDataHandler).all('*', assetsHandler)

export default { ...router }

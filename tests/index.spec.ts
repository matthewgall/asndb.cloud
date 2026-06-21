/// <reference types="@cloudflare/vitest-pool-workers" />

import {
    createExecutionContext,
    env,
    waitOnExecutionContext,
} from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

const BASE_URL = 'http://asndb.network'
const S3_ENDPOINT = 'https://s3.eu-central-1.wasabisys.com'
const S3_BUCKET = 'asndb'

type FetchInput = RequestInfo | URL

function mockFetch(responses: Map<string, Response>) {
    const originalFetch = globalThis.fetch

    globalThis.fetch = vi.fn(async (input: FetchInput) => {
        const url = input instanceof Request ? input.url : input.toString()
        const response = responses.get(url)
        if (response) {
            return response
        }
        return new Response('Not Found', { status: 404 })
    }) as typeof fetch

    return () => {
        globalThis.fetch = originalFetch
    }
}

describe('asndb.network Worker', () => {
    beforeEach(async () => {
        await env.asndb.put('latest', '2023/0101')
    })

    it('serves the index page from static assets', async () => {
        const request = new Request(`${BASE_URL}/`)
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/html')
        const body = await response.text()
        expect(body).toContain('Welcome to asndb')
    })

    it('serves the stylesheet from static assets', async () => {
        const request = new Request(`${BASE_URL}/style.css`)
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/css')
    })

    it('proxies the latest JSON data from S3', async () => {
        const restore = mockFetch(
            new Map([
                [
                    `${S3_ENDPOINT}/${S3_BUCKET}/2023/0101/ip.json`,
                    new Response('{"1.1.1.0/24": 13335}', {
                        headers: { 'content-type': 'application/json' },
                    }),
                ],
            ])
        )

        const request = new Request(`${BASE_URL}/get/latest/ip.json`)
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)
        restore()

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/json')
        expect(await response.text()).toBe('{"1.1.1.0/24": 13335}')
    })

    it('proxies the latest DAT data from S3 as binary', async () => {
        const restore = mockFetch(
            new Map([
                [
                    `${S3_ENDPOINT}/${S3_BUCKET}/2023/0101/ip.dat`,
                    new Response('binary dat payload', {
                        headers: { 'content-type': 'application/octet-stream' },
                    }),
                ],
            ])
        )

        const request = new Request(`${BASE_URL}/get/latest/ip.dat`)
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)
        restore()

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe(
            'application/octet-stream'
        )
        expect(await response.text()).toBe('binary dat payload')
    })

    it('maps historical snapshots to the expected S3 prefix', async () => {
        const restore = mockFetch(
            new Map([
                [
                    `${S3_ENDPOINT}/${S3_BUCKET}/20230101/0000/ip.json`,
                    new Response('{"legacy": true}', {
                        headers: { 'content-type': 'application/json' },
                    }),
                ],
            ])
        )

        const request = new Request(`${BASE_URL}/get/20230101/ip.json`)
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)
        restore()

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('application/json')
        expect(await response.text()).toBe('{"legacy": true}')
    })

    it('returns 404 when the S3 object is missing', async () => {
        const restore = mockFetch(new Map())

        const request = new Request(`${BASE_URL}/get/latest/missing.json`)
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)
        restore()

        expect(response.status).toBe(404)
        expect(response.headers.get('content-type')).toBe('text/plain')
        expect(await response.text()).toBe(
            'We were unable to find data for that timeframe'
        )
    })

    it('returns 404 for unknown routes', async () => {
        const request = new Request(`${BASE_URL}/not-a-route`)
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)

        expect(response.status).toBe(404)
        expect(response.headers.get('content-type')).toBe('text/plain')
        expect(await response.text()).toBe('resource not found')
    })
})

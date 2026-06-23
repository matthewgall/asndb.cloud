/// <reference types="@cloudflare/vitest-pool-workers" />

import {
    createExecutionContext,
    env,
    waitOnExecutionContext,
} from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

const BASE_URL = 'http://asndb.network'
const UPLOAD_TOKEN = 'test-upload-token'

type R2Store = Map<string, ReadableStream>
type R2PutEntry = { key: string; body: ReadableStream; options?: R2PutOptions }

function createR2Store(initial: Map<string, string>): R2Store {
    const store = new Map<string, ReadableStream>()
    for (const [key, value] of initial) {
        store.set(
            key,
            new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(value))
                    controller.close()
                },
            })
        )
    }
    return store
}

function mockR2Get(store: R2Store) {
    const originalGet = env.R2.get

    env.R2.get = vi.fn(async (key: string) => {
        const body = store.get(key)
        if (!body) {
            return null
        }
        return { body } as unknown as R2ObjectBody
    }) as unknown as typeof env.R2.get

    return () => {
        env.R2.get = originalGet
    }
}

function mockR2Put() {
    const originalPut = env.R2.put
    const entries: R2PutEntry[] = []

    env.R2.put = vi.fn(
        async (
            key: string,
            value: ReadableStream | ArrayBuffer,
            options?: R2PutOptions
        ) => {
            entries.push({ key, body: value as ReadableStream, options })
        }
    ) as unknown as typeof env.R2.put

    return {
        restore: () => {
            env.R2.put = originalPut
        },
        entries,
    }
}

function mockR2ListAndDelete(initialKeys: string[]) {
    const keys = [...initialKeys]
    const deleted: string[] = []
    const originalList = env.R2.list
    const originalDelete = env.R2.delete

    env.R2.list = vi.fn(async () => {
        return {
            objects: keys.map((key) => ({ key }) as R2Object),
            truncated: false,
        } as R2Objects
    })

    env.R2.delete = vi.fn(async (keysToDelete: string | string[]) => {
        const toDelete = Array.isArray(keysToDelete)
            ? keysToDelete
            : [keysToDelete]
        for (const key of toDelete) {
            const idx = keys.indexOf(key)
            if (idx !== -1) keys.splice(idx, 1)
            deleted.push(key)
        }
    }) as unknown as typeof env.R2.delete

    return {
        restore: () => {
            env.R2.list = originalList
            env.R2.delete = originalDelete
        },
        deleted,
    }
}

async function streamToString(stream: ReadableStream): Promise<string> {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
    }
    return new TextDecoder().decode(concatUint8Arrays(chunks))
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const arr of arrays) {
        result.set(arr, offset)
        offset += arr.length
    }
    return result
}

describe('asndb.network Worker', () => {
    beforeEach(async () => {
        await env.asndb.put('latest', '2023/0101')
        env.UPLOAD_TOKEN = UPLOAD_TOKEN
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

    it('proxies the latest JSON data from R2', async () => {
        const restore = mockR2Get(
            createR2Store(
                new Map([['2023/0101/ip.json', '{"1.1.1.0/24": 13335}']])
            )
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

    it('proxies the latest DAT data from R2 as binary', async () => {
        const restore = mockR2Get(
            createR2Store(new Map([['2023/0101/ip.dat', 'binary dat payload']]))
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

    it('maps historical snapshots to the expected R2 prefix', async () => {
        const restore = mockR2Get(
            createR2Store(
                new Map([['20230101/0000/ip.json', '{"legacy": true}']])
            )
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

    it('returns 404 when the R2 object is missing', async () => {
        const restore = mockR2Get(createR2Store(new Map()))

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

    it('accepts an authenticated single-file upload', async () => {
        const { restore, entries } = mockR2Put()

        const request = new Request(
            `${BASE_URL}/upload/20250621/2000/ip.json`,
            {
                method: 'POST',
                body: '{"1.1.1.0/24":13335}',
                headers: {
                    Authorization: `Bearer ${UPLOAD_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            }
        )
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)
        restore()

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toEqual({
            ok: true,
            prefix: '20250621/2000',
            filename: 'ip.json',
        })

        expect(entries).toHaveLength(1)
        expect(entries[0].key).toBe('20250621/2000/ip.json')
        const metadata = entries[0].options?.httpMetadata as R2HTTPMetadata
        expect(metadata.contentType).toBe('application/json')
        expect(await streamToString(entries[0].body)).toBe(
            '{"1.1.1.0/24":13335}'
        )
    })

    it('publishes a prefix and cleans old snapshots', async () => {
        const now = new Date()
        const currentPrefix = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}/2000`

        const { restore: restoreListDelete, deleted } = mockR2ListAndDelete([
            '20000101/0000/ip.json',
            '20000101/0000/ip.dat',
            '20000101/0000/asn.json',
            `${currentPrefix}/ip.json`,
        ])

        const request = new Request(`${BASE_URL}/publish/${currentPrefix}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${UPLOAD_TOKEN}`,
            },
        })
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)
        restoreListDelete()

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toEqual({
            ok: true,
            prefix: currentPrefix,
            published: true,
        })

        expect(await env.asndb.get('latest')).toBe(currentPrefix)
        expect(deleted.sort()).toEqual([
            '20000101/0000/asn.json',
            '20000101/0000/ip.dat',
            '20000101/0000/ip.json',
        ])
    })

    it('rejects upload without authorization', async () => {
        const { restore, entries } = mockR2Put()

        const request = new Request(
            `${BASE_URL}/upload/20250621/2000/ip.json`,
            {
                method: 'POST',
                body: '{}',
            }
        )
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)
        restore()

        expect(response.status).toBe(401)
        expect(entries).toHaveLength(0)
    })

    it('rejects upload with invalid prefix or filename', async () => {
        const { restore, entries } = mockR2Put()

        const request = new Request(`${BASE_URL}/upload/bad/123/bad.json`, {
            method: 'POST',
            body: '{}',
            headers: {
                Authorization: `Bearer ${UPLOAD_TOKEN}`,
            },
        })
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)
        restore()

        expect(response.status).toBe(400)
        expect(entries).toHaveLength(0)
    })

    it('runs cleanup and returns deleted snapshots', async () => {
        const now = new Date()
        const currentPrefix = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}/2000`

        const { restore, deleted } = mockR2ListAndDelete([
            '20000101/0000/ip.json',
            '20000101/0000/ip.dat',
            '20000101/0000/asn.json',
            `${currentPrefix}/ip.json`,
        ])

        const request = new Request(`${BASE_URL}/cleanup`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${UPLOAD_TOKEN}`,
            },
        })
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)
        restore()

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toEqual({
            ok: true,
            retentionDays: 14,
            deletedSnapshots: ['20000101/0000'],
            deletedKeys: 3,
        })

        expect(deleted.sort()).toEqual([
            '20000101/0000/asn.json',
            '20000101/0000/ip.dat',
            '20000101/0000/ip.json',
        ])
    })

    it('rejects cleanup without authorization', async () => {
        const { restore, deleted } = mockR2ListAndDelete([])

        const request = new Request(`${BASE_URL}/cleanup`, {
            method: 'POST',
        })
        const ctx = createExecutionContext()
        const response = await worker.fetch(request, env, ctx)
        await waitOnExecutionContext(ctx)
        restore()

        expect(response.status).toBe(401)
        expect(deleted).toHaveLength(0)
    })
})

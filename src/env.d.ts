declare global {
    interface Env {
        asndb: KVNamespace
        ASSETS: Fetcher
        S3_ENDPOINT: string
        S3_BUCKET: string
    }
}

declare module 'cloudflare:test' {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface ProvidedEnv extends Env {}
}

export {}

declare global {
    interface Env {
        asndb: KVNamespace
        ASSETS: Fetcher
        R2: R2Bucket
        UPLOAD_TOKEN: string
    }
}

declare module 'cloudflare:test' {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface ProvidedEnv extends Env {}
}

export {}

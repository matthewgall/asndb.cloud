const Router = require('./router')

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request))
})

async function api(request) {
    let path = new URL(request.url).pathname
    let resource = path.replace('/get/', '')
    let resourceInfo = resource.split('/')

    let pointer = await asndb.get('latest')

    if (resourceInfo[0] !== 'latest') {
        pointer = `${resourceInfo[0]}/0000`
    }

    // Now to fetch data
    let data = await fetch(`${S3_ENDPOINT}/${S3_BUCKET}/${pointer}/${resourceInfo[1]}`)
    if (data.status !== 200) {
        return new Response('We were unable to find data for that timeframe', {
            headers: {
                'Content-Type': 'text/plain'
            }
        })
    }

    data = await data.text()
    let ctype = 'application/json'
    if (resourceInfo[1].includes('.dat')) {
        ctype = 'application/octet-stream'
    }

    return new Response(data, {
        headers: {
            'Content-Type': ctype
        }
    })
}

async function style(request) {
    let html = await asndb.get('css')
    return new Response(html.toString(), {
        headers: {
            'Content-Type': 'text/css'
        }
    })
}

async function index(request) {
    let html = await asndb.get('index')
    return new Response(html.toString(), {
        headers: {
            'Content-Type': 'text/html'
        }
    })
}

async function handleRequest(request) {
    const r = new Router()

    /**
     * STATIC ROUTES
     */
    r.get('/style.css', () => style(request))
    r.get('/', () => index(request))

    /**
     * DYNAMIC ROUTES
     */
    r.get('/get/.*', () => api(request))

    const resp = await r.route(request)
    return resp
}
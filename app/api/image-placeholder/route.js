// Old templates invoke protected image recovery after this fails; this endpoint
// never reveals a private image or accepts a browser-supplied file ID.
export function GET() { return new Response(null,{status:404,headers:{'Cache-Control':'no-store'}}); }

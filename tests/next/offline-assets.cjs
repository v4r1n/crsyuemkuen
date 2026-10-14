const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {createHash}=require('node:crypto');
const assert=require('node:assert/strict');

// Only provisioned public, version-pinned vendor assets; never an HTTP proxy.
async function installOfflineAssets(page){
  if(!process.env.CRS_TEST_CDN_DIR)return;
  const assets=new Map([
    ['/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',['bootstrap.min.css','text/css','QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH']],
    ['/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',['bootstrap.bundle.min.js','application/javascript','YvpcrYf0tY3lHB60NNkmXc5s9fDVZLESaAA55NDzOxhy9GkcIdslK1eN7N6jIeHz']],
    ['/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',['bootstrap-icons.min.css','text/css']],
    ['/npm/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff2',['bootstrap-icons.woff2','font/woff2']],
    ['/npm/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff',['bootstrap-icons.woff','font/woff']]
  ]);
  await page.route('https://cdn.jsdelivr.net/**',async route=>{
    const asset=assets.get(new URL(route.request().url()).pathname);if(!asset){await route.abort();return;}
    const body=readFileSync(join(process.env.CRS_TEST_CDN_DIR,asset[0]));
    if(asset[2])assert.equal(createHash('sha384').update(body).digest('base64'),asset[2]);
    await route.fulfill({body,contentType:asset[1],headers:{'access-control-allow-origin':'*'}});
  });
}
module.exports={installOfflineAssets};

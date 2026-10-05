const {defineConfig}=require('@playwright/test');
module.exports=defineConfig({testDir:'./tests/next',workers:1,timeout:30000,reporter:'line',
  use:{baseURL:'http://127.0.0.1:4183',browserName:'chromium',locale:'th-TH',timezoneId:'Asia/Bangkok',trace:'retain-on-failure'},
  webServer:{command:'npm run build && npm run start -- -p 4183',url:'http://127.0.0.1:4183',env:{WEB_APP_URL:'http://127.0.0.1:4183',NEXT_TELEMETRY_DISABLED:'1'},timeout:60000,reuseExistingServer:false}});

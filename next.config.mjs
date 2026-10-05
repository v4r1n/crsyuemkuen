export default {
  poweredByHeader: false,
  serverExternalPackages: ['pg', 'exceljs'],
  outputFileTracingIncludes: { '/*': ['./src/*.gs', './public/crs/shell.html'] },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' }
    ] }];
  }
};

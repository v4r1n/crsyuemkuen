// Page layouts do not wrap the preserved HTML route handlers.
export default function Layout({children}) {
  return <html lang="th" suppressHydrationWarning><head><link rel="stylesheet" href="/crs/not-found.css" /></head><body>{children}</body></html>;
}

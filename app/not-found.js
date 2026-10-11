import {connection} from 'next/server';
import {config} from '../server/config.mjs';
import NotFoundView from '../web/not-found-view.js';

export const metadata={title:'404 · CRS Yuem-Kuen',robots:{index:false,follow:false}};
export default async function NotFound() {
  // Resolve only the configured canonical origin at request time, never Host.
  await connection();
  return <NotFoundView homeUrl={config().WEB_APP_URL} />;
}

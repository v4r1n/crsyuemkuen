import { publicLinks } from '../../../server/experience.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export function GET() {
  return Response.json(publicLinks(),{headers:{'Cache-Control':'no-store'}});
}

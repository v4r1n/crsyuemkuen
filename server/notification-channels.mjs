// Four durable opt-in states. Unknown values never grant delivery.
export function selectedChannels(value) {
  if(value==='PUSH_EMAIL')return ['PUSH','EMAIL'];
  return value==='PUSH'||value==='EMAIL'?[value]:[];
}

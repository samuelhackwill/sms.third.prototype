import { readFileSync } from 'node:fs';

export function configuration(env=process.env) {
  const saved=env.PHONE_WALL_CONFIG_FILE?JSON.parse(readFileSync(env.PHONE_WALL_CONFIG_FILE,'utf8')):{};
  const port=Number(env.PORT??saved.port??3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('invalid-controller-port');
  const keyFile=env.PHONE_WALL_ADMIN_TOKEN_FILE??saved.adminTokenFile;
  const adminToken=env.PHONE_WALL_ADMIN_TOKEN??(keyFile?readFileSync(keyFile,'utf8').trim():undefined);
  return {port,host:env.HOST??saved.bindAddress??'0.0.0.0',dataDir:env.PHONE_WALL_DATA_DIR??saved.dataDir,adminToken,
    mdns:env.PHONE_WALL_MDNS!=='false'&&saved.mdns!==false,
    serviceName:env.PHONE_WALL_NAME??saved.serviceName??'Phone Wall'};
}
export function advertisement(config) {
  return {name:config.serviceName,type:'phonewall',port:config.port,txt:{path:'/phone-wall/ws',v:'1'}};
}

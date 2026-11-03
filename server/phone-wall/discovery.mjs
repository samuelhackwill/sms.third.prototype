import { spawn } from 'node:child_process';
import { Bonjour } from 'bonjour-service';
import { advertisement } from './installation.mjs';

// On macOS, mDNSResponder must be the sole owner of local host address records.
export function startDiscovery(config,{platform=process.platform,spawnProcess=spawn,onError=()=>{},retryMs=10000}={}) {
  if(!config.mdns)return {stop(){}};
  const options=advertisement(config);
  if(platform!=='darwin') {
    const bonjour=new Bonjour({},onError);
    const service=bonjour.publish(options);
    service.on('error',onError);
    return {stop(){service.stop();bonjour.destroy();}};
  }
  let child,timer,stopped=false;
  function register() {
    child=spawnProcess('/usr/bin/dns-sd',['-R',options.name,'_phonewall._tcp','local',String(options.port),'path=/phone-wall/ws','v=1'],{stdio:'ignore'});
    let failed=false;
    const retry=()=>{
      if(stopped||failed)return;
      failed=true;onError();
      timer=setTimeout(register,retryMs);timer.unref();
    };
    child.once('error',retry);
    child.once('exit',retry);
  }
  register();
  return {stop(){stopped=true;clearTimeout(timer);child?.kill('SIGTERM');}};
}

import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import M3U8 from '../src/EXTM3U/EXTM3U.mjs';
import selectHighestQuality from '../src/function/selectHighestQuality.mjs';

function fixture() {
  const media = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://synthetic-key",KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-CONTENT-STEERING:SERVER-URI="https://example.com/steering",PATHWAY-ID="ap"
#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="English",INSTREAM-ID="CC1"
`;
  const lines = [media];
  for (const pathway of ['ap','fa','ak']) {
    for (const [audio,channels] of [['aac','2'],['ac3','6'],['atmos','16/JOC']]) {
      for (const language of ['en','de']) lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${audio}-${pathway}",NAME="${language}",LANGUAGE="${language}",DEFAULT=${language==='en'?'YES':'NO'},CHANNELS="${language==='en'?channels:'6'}",URI="${audio}-${language}-${pathway}.m3u8?signed=unaltered"`);
    }
    lines.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs-${pathway}",NAME="English",LANGUAGE="en",URI="en-${pathway}.m3u8"`);
    lines.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs-${pathway}",NAME="中文",LANGUAGE="zh",URI="zh-${pathway}.m3u8"`);
    for (const [resolution,video] of [['1920x1080','dvh1.05.03'],['3840x2160','hvc1.2.4.L150'],['3840x2160','dvh1.05.06']]) {
      for (const [audio,codec] of [['aac','mp4a.40.2'],['ac3','ac-3'],['atmos','ac-3,ec-3']]) {
        for (const bitrate of [15000000,25000000]) lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bitrate+5000000},AVERAGE-BANDWIDTH=${bitrate},RESOLUTION=${resolution},VIDEO-RANGE=PQ,FRAME-RATE=23.976,CODECS="${codec},${video}",AUDIO="${audio}-${pathway}",SUBTITLES="subs-${pathway}",CLOSED-CAPTIONS="cc",PATHWAY-ID="${pathway}",STABLE-VARIANT-ID="${resolution}-${video}-${bitrate}"
video-${resolution}-${video}-${audio}-${bitrate}-${pathway}.m3u8?signed=unaltered`);
      }
    }
  }
  return lines.join('\n');
}
const raw = fixture();
const parsed = M3U8.parse(raw);
for (const value of [false,undefined,'false',null,'']) assert.equal(selectHighestQuality(parsed,value).body,parsed);
const result = selectHighestQuality(parsed,true);
assert.equal(result.state,'locked');
assert.equal(result.resolution,'3840x2160');
assert.equal(result.video,'DolbyVision');
assert.equal(result.audio,'Atmos');
assert.equal(result.before,54);
assert.equal(result.after,3);
assert.equal(result.averageBandwidth,25000000);
const winners = result.body.filter(x=>x.TAG==='#EXT-X-STREAM-INF');
for (const v of winners) {
  assert.ok(parsed.includes(v),'Variant object/URI was replaced');
  assert.equal(v.OPTION.RESOLUTION,'3840x2160');
  assert.match(v.OPTION.AUDIO,/^atmos-/);
  assert.match(v.URI,/signed=unaltered/);
  for (const type of ['AUDIO','SUBTITLES','CLOSED-CAPTIONS']) assert.ok(result.body.some(x=>x.TAG==='#EXT-X-MEDIA' && x.OPTION.TYPE===type && x.OPTION['GROUP-ID']===v.OPTION[type]));
}
assert.equal(result.body.filter(x=>x.OPTION?.TYPE==='AUDIO').length,6,'Audio languages were lost');
for(const tag of ['#EXT-X-SESSION-KEY','#EXT-X-CONTENT-STEERING']) assert.equal(result.body.find(x=>x.TAG===tag),parsed.find(x=>x.TAG===tag));
const media = M3U8.parse('#EXTM3U\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nmain.m4s\n#EXT-X-ENDLIST');
assert.equal(selectHighestQuality(media,true).body,media);
assert.equal(selectHighestQuality(M3U8.parse('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nmissing.m3u8'),true).state,'skipped-incomplete');
const broken = M3U8.parse(raw).filter(x=>x.OPTION?.TYPE!=='AUDIO');
assert.equal(selectHighestQuality(broken,true).state,'skipped-missing-group');
const sdr = M3U8.parse('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360,CODECS="avc1.640028,mp4a.40.2"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"\nhigh.m3u8');
assert.equal(selectHighestQuality(sdr,true).resolution,'1920x1080');
assert.equal(selectHighestQuality(sdr,true).audio,'AAC');

const bundle=fs.readFileSync('plugin/scripts/Manifest.response.bundle.js','utf8');
async function run(body,enabled) {
  const storage=new Map();
  let finish;
  const done=new Promise(resolve=>{finish=resolve;});
  const context=vm.createContext({console:{log(){},error(){},warn(){}},setTimeout,clearTimeout,URL,
    $loon:{},$script:{startTime:Date.now()},
    $request:{url:'https://play-edge.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8',headers:{'User-Agent':'com.apple.tv/1.0 iOS/27.0.1 model/iPad13,8'}},
    $response:{headers:{'Content-Type':'application/vnd.apple.mpegurl'},body},
    $argument:{HighestQuality:enabled,Types:'Official,Translate','Languages[0]':'EN','Languages[1]':'ZH',LogLevel:'ERROR',GatewayURL:''},
    $persistentStore:{read:key=>storage.get(key)||null,write:(value,key)=>(storage.set(key,value),true)},
    $httpClient:{get(){throw Error('Unexpected network request');},post(){throw Error('Unexpected network request');}},$done:finish});
  vm.runInContext(bundle,context);
  return done;
}
const disabled=await run(raw,false);
assert.equal(M3U8.parse(disabled.body).filter(x=>x.TAG==='#EXT-X-STREAM-INF').length,54);
assert.equal(disabled.headers['X-AppleTV-Quality'],undefined);
const enabled=await run(raw,true);
assert.equal(M3U8.parse(enabled.body).filter(x=>x.TAG==='#EXT-X-STREAM-INF').length,3);
assert.match(enabled.headers['X-AppleTV-Quality'],/3840x2160; DolbyVision; audio=Atmos/);
assert.ok(enabled.body.includes('subtype=Translate'),'Subtitle injection stopped working');
const mediaEnabled=await run('#EXTM3U\n#EXTINF:6,\nmain.m4s\n#EXT-X-ENDLIST',true);
assert.ok(mediaEnabled.body.includes('main.m4s'));

const localFixture=process.argv.find(x=>x.startsWith('--fixture='))?.slice('--fixture='.length);
if(localFixture) {
  const body=fs.readFileSync(localFixture,'utf8');
  const replay=await run(body,true);
  const output=M3U8.parse(replay.body);
  const v=output.filter(x=>x.TAG==='#EXT-X-STREAM-INF');
  assert.equal(v.length,3);
  assert.ok(v.every(x=>x.OPTION.RESOLUTION==='3840x1920' && /dvh1/.test(x.OPTION.CODECS) && /atmos/.test(x.OPTION.AUDIO)));
  const originalUris=new Set(M3U8.parse(body).filter(x=>x.TAG==='#EXT-X-STREAM-INF').map(x=>x.URI));
  assert.ok(v.every(x=>originalUris.has(x.URI)),'Signed Apple URLs were changed');
  assert.ok(replay.body.includes('翻译字幕'));
  console.log('Private capture replay passed:', replay.headers['X-AppleTV-Quality']);
}
console.log('Highest video/audio lock, off mode, CDN fallback, language/subtitle links and media safety passed.');

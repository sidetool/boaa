import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright-core';

// Real panel, reader execution controller, normal TTS queue, HTTP client and decoded audio. The account API is synthetic.
const root = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = process.env.AUDIOBOOK_UI_ARTIFACTS || '/tmp/boaa-audiobook-ui';
await mkdir(artifacts, { recursive: true });
const source = `
import React,{useState,useEffect,useMemo} from 'react';
import {createRoot} from 'react-dom/client';
import Panel from '${root}src/ui-next/reader/UiNextAudiobookPanel.tsx';
import Library from '${root}src/ui-next/reader/UiNextVoiceLibrary.tsx';
import Revoice from '${root}src/ui-next/reader/UiNextSpeakerRevoice.tsx';
import SpeakerPanel from '${root}src/ui-next/reader/UiNextSpeakerGenerationPanel.tsx';
import {Sheet} from '${root}src/ui-next/components/primitives.tsx';
import {RemoteApiClient} from '${root}src/services/remote/remote-api-client.ts';
import {createAudiobookPort} from '${root}src/services/remote/audiobook-client.ts';
import {useTTSExecutionController} from '${root}src/features/tts/useTTSExecutionController.ts';
import {usePlainTTS} from '${root}src/features/tts/usePlainTTS.ts';
import {preparedNarrationSession} from '${root}src/providers/prepared-narration.ts';
import {runTTSPlaybackSession} from '${root}src/providers/tts-playback-session-runner.ts';
import {DEFAULT_TTS_PLAYBACK_SETTINGS} from '${root}src/providers/tts-playback-settings.ts';
import '${root}src/ui-next/styles/tokens.css';
import '${root}src/ui-next/styles/kit.css';
import '${root}src/styles/base.css';
const client = new RemoteApiClient('/api',{getAuthToken:()=> 'fixture'});
const port=createAudiobookPort(client,'book');
const systemTTS={pause(){},resume(){},stop(){}};
const owner={};
const reviewVoices=[{id:'a',label:'기본 목소리',lang:'ko',providerName:'검증 엔진'},
 {id:'b',label:'아주 긴 이름을 가진 두 번째 목소리',lang:'ko',providerName:'검증 엔진',modelId:'gemini-3.8-flash-tts',instructionsSupported:true,paid:true}];
let reviewRows=[{id:'row',voiceId:'a',alias:'차분한 목소리',timbre:'낮은, 부드러운',description:'차분한 인물에게 어울려요.',language:'ko',enabled:true,providerId:'fixture',providerVoiceId:'a',model:{providerId:'fixture',modelId:'fixture-model',revision:'1'},origin:'catalog',available:true,sampleAvailable:false}];
const reviewCalls=[]; window.reviewCalls=reviewCalls;
const reviewPort={list:async()=>({voices:reviewRows,designers:[]}),save:async(v,s,id)=>{reviewRows=[{...reviewRows[0],...v}];reviewCalls.push({kind:'save',id,value:v});return reviewRows[0];}};
// Automatic acting: capable voices, one ordinary voice and one analysis connection; preferences live in sessionStorage.
const q=new URLSearchParams(location.search), acting=q.has('acting');
const actVoices=[{id:'g1',label:'연기 1',lang:'ko',providerId:'g',providerName:'연기 엔진',autoActingSupported:true,instructionsSupported:true},
 {id:'g2',label:'연기 2',lang:'ko',providerId:'g',providerName:'연기 엔진',autoActingSupported:true},
 {id:'x1',label:'일반 1',lang:'ko',providerId:'x',providerName:'일반 엔진'}];
const analysis=[{id:'e1',name:'분석 A',modelId:'model-a',enabled:true,paid:true,purpose:'analysis',revision:'1'}];
const speakerPort={preferences:async()=>JSON.parse(sessionStorage.prefs||'null')??undefined,
 savePreferences:async(v)=>{sessionStorage.prefs=JSON.stringify(v);reviewCalls.push({kind:'prefs',value:v});},
 list:async()=>[],remove:async()=>{},control:async()=>({}),create:async()=>({}),
 estimate:async(input)=>{reviewCalls.push({kind:'speakerEstimate',input});return {fingerprint:'s',chapterCount:1,contextChapterCount:0,characters:900,modelLabel:'분석 A',voiceLabel:'연기 1',paid:true};}};
// Natural voice creation (&design): a selection connection and a verified design connection.
const design=q.has('design');
const selectors=[{id:'c1',name:'선정 A',modelId:'select-a',enabled:true,paid:true,purpose:'casting',revision:'1'}];
const designers=[{id:'d1',name:'Gemini 3.8 제작',modelId:'gemini-3.8-flash-tts',paid:true}];
const allEngines=design?[...analysis,...selectors]:analysis;
const designLibrary={list:async()=>({voices:[],designers}),save:async()=>({}),remove:async()=>{},design:async()=>({}),sample:async()=>new Blob()};
const enginesPort={list:async()=>allEngines,probe:async()=>({}),save:async()=>({}),remove:async()=>{}};
const revoicePort={revoiceSource:async()=>({chapterCount:1,itemCount:12,...(acting?{hasActing:false,needsActing:true,actingEngineId:'e1'}:{}),
 voices:[{speakerId:'narrator',name:'내레이터',voiceId:acting?'g1':'a',itemCount:8},{speakerId:'p1',name:'이름이매우길어서모바일에서줄바꿈이필요한등장인물',voiceId:acting?'g2':'a',itemCount:4}]}),
 estimateRevoice:async(id,input)=>{reviewCalls.push({kind:'estimate',input});return {fingerprint:'r',chapterCount:1,itemCount:12,characters:1500,paid:true,actingAnalysis:input.acting?.mode==='auto',
  ...(input.casting?{recastCharacters:1,selectionModelLabel:'선정 A',maxDesignedVoices:input.casting.maxDesignedVoices}:{})};},
 revoice:async(id,input,fingerprint,confirmPaid)=>{reviewCalls.push({kind:'create',input,confirmPaid});return {id:'variant',revoiceFrom:id};}};
function ReviewFixture(){const review=q.get('review');return <div className="ui-next"><Sheet open title={review==='library'?'목소리 보관함':'화자별 미리 생성하기'} onClose={()=>{}}>{review==='library'?<Library port={reviewPort} voices={reviewVoices} onChanged={()=>{}}/>
 :review==='acting'?<SpeakerPanel controls={{key:'acting',port:speakerPort,engines:enginesPort,...(design?{voiceLibrary:designLibrary}:{}),chapters:[{id:'c1',title:'1화'}],currentChapterId:'c1',narratorVoiceId:q.get('narrator')||'g1',rules:[],footnotePlayback:'skip',
  voices:{available:true,defaultVoiceId:'g1',voices:actVoices,providers:[{id:'g',name:'연기 엔진',available:true,paid:true},{id:'x',name:'일반 엔진',available:true,paid:false}]},listen(){},refreshVoices(){}}}/>
 :<div className="un-book-item"><Revoice job={{id:'source',status:'paused',chapterCount:2,itemCount:12,planningComplete:false}} port={revoicePort} voices={acting?actVoices:reviewVoices} library={reviewRows} engines={allEngines} designers={design?designers:[]} onCreated={()=>reviewCalls.push({kind:'reload'})}/></div>}</Sheet></div>}
function Fixture(){
 const [open,setOpen]=useState(true);
 const [choice,setChoice]=useState(); const [chapter,setChapter]=useState('c1'); const [done,setDone]=useState(false);
 const controller=useTTSExecutionController({systemTTS,sessionOwner:owner,bookId:'book',chapterId:chapter,playbackRate:1.1,volume:0.5});
 const settings=useMemo(()=>({...DEFAULT_TTS_PLAYBACK_SETTINGS,voiceSource:'server',serverVoiceId:'different-current-voice',plainChunking:'sentence',rate:1.1}),[]);
 const plain=usePlainTTS({client,owner,enabled:true,prepared:port,controller,systemTTS,settings,rules:[],chapterId:chapter,contentRevision:'r1',onError:(message)=>{window.playbackError=message;}});
 useEffect(()=>{
  if(!choice)return;
  const session=controller.beginSession('book',chapter,0);
  const signal=controller.sessionSignal(session);
  (async()=>{
   const plan=await port.reader(chapter,{id:choice.id},signal);
   if(!controller.isSessionCurrent(session))return;
   const paragraphs=plan.items.map(item=>({id:item.playable.paragraphId,index:item.paragraphIndex+1,chapterId:chapter,novelId:'book',text:item.playable.text}));
   const result=await runTTSPlaybackSession({
    ...preparedNarrationSession(plan,0,async i=>paragraphs[i]),
    shouldContinue:()=>controller.isSessionCurrent(session),signal,waitForResume:()=>controller.waitForResume(session),
    buildPlayableSegments:()=>{throw Error('must use recorded plan');},allowSystemFallback:false,
    playHostedSegment:(playable,paragraph)=>plain.play(playable,paragraph,session),
    prefetchHostedSegment:(playable,paragraph)=>plain.prefetch(playable,paragraph,session),
    speakSystem:async()=>{throw Error('no system fallback');},buildSystemFallbackInput:()=>({text:'unused',rate:1}),
    onParagraphStart:(i,p)=>{controller.setParagraph(session,i);window.followed.push(p.id);},
    onActivePlayback:p=>controller.setActivePlayback(session,p),
   });
   if(result.completed){controller.finishSession(session);if(chapter==='c1')setChapter('c2');else setDone(true);}
  })().catch(e=>{if(!signal?.aborted)window.playbackError=String(e);});
  return ()=>controller.stopAll();
 },[choice,chapter]);
 return <div className="ui-next">
 <button onClick={()=>setOpen(true)}>열기</button>
 {!open&&<main aria-label="본문"><h2>{chapter==='c1'?'1화':'2화'}</h2><p data-testid="follow">{controller.activePlayback?.paragraphId}</p><p>{done?'끝까지 들었어요.':controller.hostedStatus}</p></main>}
 {open&&<Sheet open title="미리 생성하기" onClose={()=>setOpen(false)}><Panel controls={{
 key:'fixture:book',port,chapters:[{id:'c1',title:'1화 · 긴 제목의 시작 이야기'},{id:'c2',title:'2화 · 이어지는 이야기'}],currentChapterId:'c1',
 generation:location.search.includes('offline')?undefined:{voiceId:'fixture',modelRevision:'v1',chunking:'batch',footnotePlayback:'skip',rules:[]},
 rate:1.1,volume:0.5,listen:(item)=>{controller.stopAll();window.followed=[];setChoice(item);setChapter('c1');setDone(false);setOpen(false);}
 }}/></Sheet>}</div>}
const OriginalAudio=window.Audio;
window.Audio=function(...args){const audio=new OriginalAudio(...args);
 audio.addEventListener('playing',()=>{window.actualPlaying=(window.actualPlaying||0)+1;window.actualAudio=audio;});
 audio.addEventListener('timeupdate',()=>{if(audio.currentTime>0)window.audioAdvanced=true;});return audio;};
createRoot(document.getElementById('root')).render(location.search.includes('review=')?<ReviewFixture/>:<Fixture/>);`;
const { output } = await build({
  root,
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'audiobook-fixture',
      resolveId: (id) => (id === 'fixture' ? '\0fixture.tsx' : undefined),
      load: async (id) =>
        id === '\0fixture.tsx'
          ? (await transformWithEsbuild(source, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code
          : undefined,
    },
  ],
  build: { write: false, rollupOptions: { input: 'fixture' } },
});
const entry = output.find((asset) => asset.isEntry);
const audio = Buffer.alloc(44 + 16000);
audio.write('RIFF', 0);
audio.writeUInt32LE(audio.length - 8, 4);
audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(16000, 24);
audio.writeUInt32LE(32000, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write('data', 36);
audio.writeUInt32LE(audio.length - 44, 40);
const estimate = {
  fingerprint: 'fixture',
  chapterCount: 1,
  itemCount: 2,
  characters: 250,
  voiceLabel: '저장 목소리',
  providerName: 'Fixture API',
  paid: true,
  firstChapterTitle: '1화 · 긴 제목의 시작 이야기',
  lastChapterTitle: '1화 · 긴 제목의 시작 이야기',
};
const completed = {
  ...estimate,
  id: 'saved',
  bookId: 'book',
  title: '긴 제목의 테스트 작품',
  status: 'completed',
  completedItems: 2,
  bytes: audio.length * 2,
  playbackIndex: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
let jobs = [];
const calls = [];

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const pathname = url.pathname;
  if (pathname.startsWith('/api/')) {
    assert.equal(request.headers.authorization, 'Bearer fixture');
    let raw = '';
    for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: request.method, path: pathname, body });
    response.setHeader('Content-Type', 'application/json');
    if (pathname.endsWith('/estimate')) return response.end(JSON.stringify(estimate));
    if (pathname === '/api/books/book/audiobooks') {
      if (request.method === 'POST') {
        assert.equal(body.confirmPaid, true);
        const job = { ...completed, id: 'queued', status: 'queued', completedItems: 0, bytes: 0 };
        jobs = [job, ...jobs.filter((x) => x.id !== job.id)];
        return response.end(JSON.stringify(job));
      }
      return response.end(JSON.stringify({ audiobooks: jobs }));
    }
    if (pathname === '/api/tts/plain/voices')
      return response.end(JSON.stringify({ available: false, voices: [], revision: 'offline' }));
    if (pathname.endsWith('/audiobooks/reader')) {
      const chapterId = url.searchParams.get('chapterId');
      const offset = chapterId === 'c1' ? 0 : 2;
      const items = [0, 1].map((i) => ({
        ordinal: offset + i,
        paragraphIndex: i,
        nextParagraphIndex: i + 1,
        playable: {
          paragraphId: chapterId + '-' + i,
          text: '본문의 ' + (i + 1) + '번째 문장입니다.',
          spokenTextFingerprint: chapterId + '-' + i,
          speakerId: 'narrator',
          speakerLabel: '저장 목소리',
          emotion: 'neutral',
          rate: 1,
          sourceSegmentIds: [],
          sourceRanges: [{ paragraphId: chapterId + '-' + i, segmentId: 's' + i, startOffset: 0, endOffset: 10 }],
          preparedAudio: { id: 'saved', ordinal: offset + i, ready: i === 0 },
        },
      }));
      return response.end(
        JSON.stringify({ plan: { id: 'saved', chapterId, contentRevision: 'r1', voiceLabel: '저장 목소리', items } }),
      );
    }
    const id = pathname.split('/')[3];
    const job = jobs.find((x) => x.id === id);
    if (pathname.includes('/audio/')) {
      if (Number(pathname.split('/').at(-1)) % 2) return response.writeHead(404).end('{}');
      response.setHeader('Content-Type', 'audio/wav');
      return response.end(audio);
    }
    if (pathname.includes('/resolve/')) {
      response.setHeader('Content-Type', 'audio/wav');
      return response.end(audio);
    }
    if (pathname.endsWith('/progress')) {
      job.playbackIndex = body.index;
      return response.end('{}');
    }
    if (pathname.endsWith('/control')) {
      job.status = body.action === 'pause' ? 'paused' : 'queued';
      return response.end(JSON.stringify(job));
    }
    if (request.method === 'DELETE') {
      jobs = jobs.filter((x) => x.id !== id);
      return response.end('{}');
    }
    return response.writeHead(404).end('{}');
  }
  const asset = output.find((x) => '/' + x.fileName === pathname);
  response.setHeader(
    'Content-Type',
    asset ? (asset.type === 'chunk' ? 'application/javascript' : 'text/css') : 'text/html',
  );
  response.end(
    asset
      ? (asset.code ?? asset.source)
      : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${output
          .filter((x) => x.fileName.endsWith('.css'))
          .map((x) => `<link rel="stylesheet" href="/${x.fileName}">`)
          .join('')}<div id="root"></div><script type="module" src="/${entry.fileName}"></script>`,
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
let activePage;
const checks = [];
const errors = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.READER_UI_BROWSER_EXECUTABLE });
  for (const width of process.env.AUDIOBOOK_UI_PLAYBACK_ONLY || process.env.AUDIOBOOK_UI_REVOICE_ONLY
    ? []
    : [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    activePage = page;
    page.on('pageerror', (e) => errors.push(e.message));
    jobs = [structuredClone(completed)];
    calls.length = 0;
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: '글자 수 확인', exact: true }).click();
    const start = page.getByRole('button', { name: '생성 시작', exact: true });
    await start.waitFor();
    assert.equal(await start.isDisabled(), true);
    assert.equal(calls.filter((x) => x.path.includes('/audio/')).length, 0);
    const bounds = await page.getByRole('dialog').evaluate((el) => ({
      width: el.clientWidth,
      scroll: el.scrollWidth,
      left: el.getBoundingClientRect().left,
      right: el.getBoundingClientRect().right,
    }));
    assert(bounds.scroll <= bounds.width + 1 && bounds.left >= 0 && bounds.right <= width + 1, JSON.stringify(bounds));
    await page.screenshot({ path: `${artifacts}/estimate-${width}.png` });
    await page.getByRole('checkbox').check();
    await start.click();
    await page.getByText('대기 중', { exact: true }).waitFor();
    assert.equal(calls.filter((x) => x.method === 'POST' && x.path === '/api/books/book/audiobooks').length, 1);
    await page.getByRole('button', { name: '멈추기', exact: true }).click();
    await page.getByText('멈춤', { exact: true }).waitFor();
    await page.getByRole('button', { name: '이어 만들기', exact: true }).click();
    const confirm = page.getByRole('group', { name: '이어 만들기 확인' });
    await confirm.waitFor();
    assert.equal(calls.filter((x) => x.body?.action === 'resume').length, 0);
    await page.screenshot({ path: `${artifacts}/paused-${width}.png` });
    await context.close();
    checks.push(`${width}: cold layout, estimate consent, create, pause and resume confirmation`);
  }
  if (process.env.AUDIOBOOK_UI_REVOICE_ONLY || process.env.AUDIOBOOK_UI_LAYOUT_ONLY) {
    for (const width of process.env.AUDIOBOOK_UI_LAYOUT_ONLY ? [320, 390] : [320, 390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      activePage = page;
      page.on('pageerror', (e) => errors.push(e.message));
      const bounded = async () => {
        const failures = await page.locator('input,textarea,select,button').evaluateAll((els) =>
          els
            .filter((el) => el.getClientRects().length)
            .flatMap((el) => {
              const r = el.getBoundingClientRect();
              const d = el.closest('[role="dialog"]')?.getBoundingClientRect();
              return d && (r.left < d.left - 1 || r.right > d.right + 1)
                ? [{ tag: el.tagName, left: r.left, right: r.right }]
                : [];
            }),
        );
        assert.deepEqual(failures, []);
      };
      await page.goto(`http://127.0.0.1:${server.address().port}/?review=library`);
      await page.getByRole('button', { name: '수정', exact: true }).click();
      await page.getByRole('button', { name: '여성적인', exact: true }).click();
      await page.getByRole('button', { name: '젊은', exact: true }).click();
      await page.getByRole('button', { name: '젊은', exact: true }).hover();
      assert.equal(
        await page
          .getByRole('button', { name: '젊은', exact: true })
          .evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(245, 245, 247)',
      );
      await bounded();
      await page.screenshot({ path: `${artifacts}/library-${width}.png` });
      await page.getByRole('button', { name: '저장', exact: true }).click();
      assert.equal(await page.evaluate(() => window.reviewCalls[0].value.timbre.includes('여성적인')), true);
      await page.goto(`http://127.0.0.1:${server.address().port}/?review=revoice`);
      await page.getByText('음성 다시 만들기', { exact: true }).click();
      await page.getByText(/아직 분석하지 않은 나머지 회차/).waitFor();
      await page
        .getByRole('combobox', { name: '이름이매우길어서모바일에서줄바꿈이필요한등장인물 새 목소리', exact: true })
        .selectOption('b');
      // Manual directions stay folded until asked for.
      assert.equal(await page.getByRole('textbox').count(), 0);
      await page.getByRole('button', { name: '직접 연기 지시 추가', exact: true }).click();
      await page
        .getByRole('textbox', { name: '이름이매우길어서모바일에서줄바꿈이필요한등장인물 연기 지시', exact: true })
        .fill('차분하고 또렷하게, 서두르지 않고 말해 주세요.');
      await page.getByText(/Gemini 3.8: 이 인물의 대사/).waitFor();
      const cue = page.getByRole('button', { name: '지친 듯', exact: true });
      await cue.click();
      assert.equal(await cue.isDisabled(), true);
      const chipStyle = await cue.evaluate((el) => ({
        color: getComputedStyle(el).color,
        background: getComputedStyle(el).backgroundColor,
      }));
      assert.notEqual(chipStyle.color, chipStyle.background);
      assert.deepEqual(
        await page
          .locator('.un-revoice .un-chip-row')
          .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent)),
        [],
      );
      assert.deepEqual(
        await page
          .locator('.un-revoice-row label > span')
          .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent)),
        [],
      );
      assert.equal(
        await page.locator('.un-revoice textarea').evaluate((el) => getComputedStyle(el).borderTopWidth),
        '1px',
      );
      await bounded();
      await page.getByRole('button', { name: '다시 만들 범위 확인', exact: true }).click();
      const create = page.getByRole('button', { name: '새 음성 만들기', exact: true });
      await create.waitFor();
      assert.equal(await create.isDisabled(), true);
      await page.getByRole('checkbox').check();
      await bounded();
      await page.screenshot({ path: `${artifacts}/revoice-${width}.png` });
      await create.click();
      await page.getByText(/새 음성 작업을 만들었어요/).waitFor();
      const creates = await page.evaluate(() => window.reviewCalls.filter((c) => c.kind === 'create'));
      assert.equal(creates.length, 1);
      assert.equal(creates[0].confirmPaid, true);
      assert.equal(creates[0].input.voices[1].instructions, '차분하고 또렷하게, 서두르지 않고 말해 주세요., 지친 듯');
      const port = server.address().port;
      const enabled = (name) =>
        page.waitForFunction(
          (n) => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === n && !b.disabled),
          name,
        );
      const lastCall = (kind) => page.evaluate((k) => window.reviewCalls.filter((c) => c.kind === k).at(-1), kind);
      const actingToggle = () => page.getByRole('checkbox', { name: /장면에 맞춰 감정/ });
      const overflowing = () =>
        page
          .locator('.un-cast-field > span, .un-book-ack > span')
          .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));

      // New generation: on by default for capable voices without saving, explicit off saved and restored.
      await page.goto(`http://127.0.0.1:${port}/?review=acting`);
      await enabled('분석 범위 확인');
      assert.equal(await actingToggle().isChecked(), true);
      assert.equal(await lastCall('prefs'), undefined);
      await page.getByRole('button', { name: '분석 범위 확인', exact: true }).click();
      await page.getByRole('button', { name: '생성 시작', exact: true }).waitFor();
      assert.equal((await lastCall('speakerEstimate')).input.autoActing, true);
      await bounded();
      assert.deepEqual(await overflowing(), []);
      await page.screenshot({ path: `${artifacts}/acting-${width}.png` });
      await actingToggle().uncheck();
      await page.waitForFunction(() => window.reviewCalls.some((c) => c.kind === 'prefs'));
      assert.equal((await lastCall('prefs')).value.autoActing, false);
      await page.reload();
      await enabled('분석 범위 확인');
      assert.equal(await actingToggle().isChecked(), false);
      await page.getByRole('button', { name: '분석 범위 확인', exact: true }).click();
      await page.getByRole('button', { name: '생성 시작', exact: true }).waitFor();
      assert.equal((await lastCall('speakerEstimate')).input.autoActing, false);

      // Ordinary voices with no saved choice: off and disabled, no blocking message, flag left out.
      await page.evaluate(() => sessionStorage.clear());
      await page.goto(`http://127.0.0.1:${port}/?review=acting&narrator=x1`);
      await enabled('분석 범위 확인');
      assert.equal(await actingToggle().isChecked(), false);
      assert.equal(await actingToggle().isDisabled(), true);
      assert.equal(await page.getByText('자동 연기를 지원하지 않는 목소리가 있어요').count(), 0);
      await page.getByRole('button', { name: '분석 범위 확인', exact: true }).click();
      await page.getByRole('button', { name: '생성 시작', exact: true }).waitFor();
      assert.equal('autoActing' in (await lastCall('speakerEstimate')).input, false);

      // Re-voicing an untagged capable source: fills acting with the original analysis model by default.
      await page.goto(`http://127.0.0.1:${port}/?review=revoice&acting`);
      await page.getByText('음성 다시 만들기', { exact: true }).click();
      const mode = page.getByRole('combobox', { name: '자동 연기', exact: true });
      await mode.waitFor();
      assert.equal(await mode.inputValue(), 'auto');
      assert.equal(await page.getByRole('combobox', { name: '연기 분석 모델', exact: true }).inputValue(), 'e1');
      assert.equal(await page.getByRole('textbox').count(), 0);
      await page.getByRole('button', { name: '다시 만들 범위 확인', exact: true }).click();
      const actingCreate = page.getByRole('button', { name: '새 음성 만들기', exact: true });
      await actingCreate.waitFor();
      await page.getByText(/연기 분석 모델의 API 사용 요금/).waitFor();
      await page.getByRole('checkbox').check();
      await bounded();
      assert.deepEqual(
        await page
          .locator('.un-revoice-row label > span')
          .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent)),
        [],
      );
      await page.screenshot({ path: `${artifacts}/revoice-acting-${width}.png` });
      await actingCreate.click();
      await page.getByText(/새 음성 작업을 만들었어요/).waitFor();
      assert.deepEqual((await lastCall('create')).input.acting, { mode: 'auto', engineId: 'e1' });
      // Natural voice creation: an explicit mode with selection model, design connection and budget, no names to fill.
      await page.evaluate(() => sessionStorage.clear());
      await page.goto(`http://127.0.0.1:${port}/?review=acting&design`);
      await enabled('분석 범위 확인');
      const castingSelect = (name) => page.getByRole('combobox', { name, exact: true });
      assert.equal(await castingSelect('인물 목소리 정하기').inputValue(), 'order');
      await castingSelect('인물 목소리 정하기').selectOption('create');
      assert.equal(await castingSelect('목소리 선정 모델').inputValue(), 'c1');
      assert.equal(await castingSelect('목소리 제작 연결').inputValue(), 'd1');
      await castingSelect('새로 만들 목소리').selectOption('3');
      await page.getByText(/엑스트라·대체용 목소리/).waitFor();
      await page.getByRole('button', { name: '분석 범위 확인', exact: true }).click();
      await page.getByRole('button', { name: '생성 시작', exact: true }).waitFor();
      assert.deepEqual((await lastCall('speakerEstimate')).input.casting, {
        engineId: 'c1',
        autoDesign: true,
        designMode: 'characters',
        designProviderId: 'd1',
        designModelId: 'gemini-3.8-flash-tts',
        maxDesignedVoices: 3,
      });
      await bounded();
      assert.deepEqual(await overflowing(), []);
      await page.screenshot({ path: `${artifacts}/design-${width}.png` });

      // Re-voicing with new character voices on top of the automatic acting default.
      await page.goto(`http://127.0.0.1:${port}/?review=revoice&acting&design`);
      await page.getByText('음성 다시 만들기', { exact: true }).click();
      await castingSelect('인물 목소리').waitFor();
      assert.equal(await castingSelect('인물 목소리').inputValue(), 'keep');
      await castingSelect('인물 목소리').selectOption('create');
      assert.equal(await castingSelect('목소리 선정 모델').inputValue(), 'c1');
      await page.getByRole('button', { name: '다시 만들 범위 확인', exact: true }).click();
      const designCreate = page.getByRole('button', { name: '새 음성 만들기', exact: true });
      await designCreate.waitFor();
      await page.getByText(/목소리 선정·제작과 연기 분석 모델의 API 사용 요금/).waitFor();
      await page.getByRole('checkbox').check();
      await bounded();
      assert.deepEqual(
        await page
          .locator('.un-revoice-row label > span')
          .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent)),
        [],
      );
      await page.screenshot({ path: `${artifacts}/revoice-design-${width}.png` });
      await designCreate.click();
      await page.getByText(/새 음성 작업을 만들었어요/).waitFor();
      const designed = (await lastCall('create')).input;
      assert.equal(designed.casting.designMode, 'characters');
      assert.deepEqual(designed.acting, { mode: 'auto', engineId: 'e1' });
      checks.push(
        `${width}: metadata editing, bounded fields/chips, partial revoice source, separate instructions, consent and one create; acting default on/explicit off/unsupported off and revoice auto-fill default; natural voice creation for new and revoiced jobs`,
      );
      await context.close();
    }
  }
  if (!process.env.AUDIOBOOK_UI_LAYOUT_ONLY) {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    activePage = page;
    page.on('pageerror', (e) => errors.push(e.message));
    jobs = [structuredClone(completed)];
    calls.length = 0;
    await page.goto(`http://127.0.0.1:${server.address().port}/?offline`);
    await page.getByRole('button', { name: '본문에서 듣기', exact: true }).click();
    await page.getByRole('main', { name: '본문' }).waitFor();
    await page.waitForFunction(() => window.actualPlaying > 0);
    await page.evaluate(() => window.actualAudio.pause());
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByText('끝까지 들었어요.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.playbackError), undefined);
    assert.deepEqual(await page.evaluate(() => window.followed), ['c1-0', 'c1-1', 'c2-0', 'c2-1']);
    assert.deepEqual(
      calls.filter((x) => x.path.includes('/resolve/')).map((x) => x.path),
      [1, 3].map((i) => '/api/audiobooks/saved/resolve/' + i),
    );
    assert.equal(await page.evaluate(() => window.audioAdvanced), true);
    assert((await page.evaluate(() => window.actualPlaying)) >= 5);
    assert.equal(calls.filter((x) => x.path.includes('/tts/plain') && x.method === 'POST').length, 0);
    assert.equal(calls.filter((x) => x.path.endsWith('/estimate') || x.path.endsWith('/progress')).length, 0);
    await page.screenshot({ path: `${artifacts}/reader-390.png` });
    await context.close();
    checks.push(
      'reader handoff: same TTS controller decoded four clips across two chapters, matching source highlights, offline catalog and different current settings, no independent player or ordinary synthesis request',
    );
  }
  assert.deepEqual(errors, []);
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: `${artifacts}/failure.png` });
    await writeFile(
      `${artifacts}/failure.json`,
      JSON.stringify(
        { error: String(error), calls, errors, text: await activePage.locator('body').innerText() },
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(`${artifacts}/result.json`, JSON.stringify({ checks, errors, browserClosed: true }, null, 2));
}
console.log(JSON.stringify({ ok: true, checks }));

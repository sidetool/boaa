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
const client = new RemoteApiClient('/api',{getAuthToken:()=> 'fixture'});
const port=createAudiobookPort(client,'book');
const systemTTS={pause(){},resume(){},stop(){}};
const owner={};
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
createRoot(document.getElementById('root')).render(<Fixture/>);`;
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
  for (const width of process.env.AUDIOBOOK_UI_PLAYBACK_ONLY ? [] : [320, 390, 1280]) {
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
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  activePage = page;
  page.on('pageerror', (e) => errors.push(e.message));
  jobs = [structuredClone(completed)];
  calls.length = 0;
  await page.goto(`http://127.0.0.1:${server.address().port}/?offline`);
  await page.getByRole('button', { name: '본문에서 듣기', exact: true }).click();
  await page.getByRole('main', { name: '본문' }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByText('끝까지 들었어요.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.playbackError), undefined);
  assert.deepEqual(await page.evaluate(() => window.followed), ['c1-0', 'c1-1', 'c2-0', 'c2-1']);
  assert.deepEqual(
    calls.filter((x) => x.path.includes('/resolve/')).map((x) => x.path),
    [0, 1, 2, 3].map((i) => '/api/audiobooks/saved/resolve/' + i),
  );
  assert.equal(calls.filter((x) => x.path.includes('/tts/plain') && x.method === 'POST').length, 0);
  assert.equal(calls.filter((x) => x.path.endsWith('/estimate') || x.path.endsWith('/progress')).length, 0);
  await page.screenshot({ path: `${artifacts}/reader-390.png` });
  await context.close();
  checks.push(
    'reader handoff: same TTS controller decoded four clips across two chapters, matching source highlights, offline catalog and different current settings, no independent player or ordinary synthesis request',
  );
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

"""Execute isolated smoke tests against a final native image (no replacement app mounts)."""
import argparse
import json
from pathlib import Path
import platform
import subprocess
import time
import uuid


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--image', required=True)
    p.add_argument('--component', required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    info = json.loads(subprocess.check_output(['docker', 'image', 'inspect', a.image], text=True))[0]
    expected = {'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]
    if info['Architecture'] != expected:
        raise ValueError('smoke_must_run_natively')
    results = []
    def execute(label, entrypoint, args, env=()):
        name = 'boaa-native-smoke-' + uuid.uuid4().hex[:12]
        command = ['docker', 'create', '--name', name, '--network', 'none']
        for value in env:
            command += ['-e', value]
        command += ['--entrypoint', entrypoint, info['Id'], *args]
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
        try:
            result = subprocess.run(['docker', 'start', '-a', name], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
            output = result.stdout
            if result.returncode:
                raise ValueError(label + '\n' + output)
            status = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.ExitCode}}', name], text=True).strip()
            if status != '0':
                raise ValueError(label + '\n' + output)
            results.append({'test': label, 'passed': True, 'output': output[-16000:]})
            print('PASS', label, flush=True)
        finally:
            subprocess.run(['docker', 'rm', '-f', name], check=True, stdout=subprocess.DEVNULL)
    if a.component == 'server':
        execute('sharp native decode/resize; QuickJS and archive WASM load', 'node', ['--input-type=module', '-e', r'''
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.resolve('@boaa/extension-runtime'));
const { newQuickJSWASMModuleFromVariant }=require('quickjs-emscripten-core');
const variant=require('@jitl/quickjs-wasmfile-release-sync').default;
const image=await sharp({create:{width:2,height:2,channels:3,background:'#fff'}}).png().toBuffer();
assert.equal((await sharp(image).resize(1,1).metadata()).format,'png');
const q=await newQuickJSWASMModuleFromVariant(variant);const vm=q.newContext();const r=vm.evalCode('6*7');assert.equal(vm.dump(r.value),42);r.value.dispose();vm.dispose();
const seven=await import('7z-wasm');const z=await (seven.default||seven)();assert.ok(z.FS);
const lib=await import('libarchive-wasm');const mod=await lib.libarchiveWasm();assert.ok(mod);
console.log('native sharp/QuickJS/7z/libarchive modules available');
'''])
        execute('PDF structure, metadata and text without optional native Canvas', 'node', ['--input-type=module', '-e', r'''
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
assert.throws(()=>require.resolve('@napi-rs/canvas'));
assert.equal(typeof DOMMatrix,'function');
const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
const objects=[
'<< /Type /Catalog /Pages 2 0 R >>',
'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
'<< /Length 36 >>\nstream\nBT /F1 12 Tf 10 10 Td (BOAA) Tj ET\nendstream',
'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
'<< /Title (BOAA smoke) >>'];
let data='%PDF-1.4\n';const offsets=[0];
for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
const xref=Buffer.byteLength(data);data+=`xref\n0 7\n0000000000 65535 f \n`;
for(const offset of offsets.slice(1)) data+=String(offset).padStart(10,'0')+' 00000 n \n';
data+=`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const document=await pdfjs.getDocument({data:new Uint8Array(Buffer.from(data)),useWorkerFetch:false}).promise;
assert.equal(document.numPages,1);assert.equal((await document.getMetadata()).info.Title,'BOAA smoke');
const page=await document.getPage(1);assert.equal((await page.getTextContent()).items.map(i=>i.str).join(''),'BOAA');
await document.destroy();console.log('PDF inspection/text PASS without native Canvas/Skia');
'''])
        execute('embedded static ByeDPI', '/usr/local/bin/byedpi', ['--version'])
        execute('base image excludes Java and Chromium', 'sh', ['-ec', '! command -v java; ! command -v chromium; test ! -d /payload/java'])
    elif a.component == 'apk':
        execute('native JRE and modified APK worker class loading', '/payload/java/bin/java', ['-cp', '/payload/runtime/target/apk-worker-0.1.0.jar:/payload/runtime/dependencies/*:/payload/runtime/smoke', 'AndroidDispatcherSmoke'])
        execute('APK oneshot installation and manifest', 'sh', ['-ec', 'node apk-payload.mjs; test -f /opt/boaa-runtimes/apk/current/manifest.json'], ['BOAA_APK_RUNTIME_ROOT=/opt/boaa-runtimes/apk'])
    elif a.component == 'browser':
        execute('native Chromium, both drivers, proxy and authentication', 'node', ['browser-smoke.mjs'])
    elif a.component == 'metadata':
        execute('Python native dependencies and synthetic provider', 'python', ['-c', r'''
import fastapi,uvicorn,httpx,bs4,lxml.etree,playwright,json
print('BOAA_COMPILED_LIBRARIES:'+json.dumps({'libxml2':'.'.join(map(str,lxml.etree.LIBXML_COMPILED_VERSION)),'libxslt':'.'.join(map(str,lxml.etree.LIBXSLT_COMPILED_VERSION))}))
from pathlib import Path
import os
os.environ['BOAA_RUNTIME_TOKEN']='a'*64
p=Path('/tmp/provider.py');p.write_text("from fastapi import FastAPI\ndef create_app(context):\n app=FastAPI()\n @app.get('/api/v1/search')\n def synthetic(): return {'value':42}\n return app\n")
os.environ['BOAA_METADATA_PROVIDER_ROOT']='/tmp'
os.environ['BOAA_METADATA_PROVIDER']=str(p)
from metadata_runner import create_app
app=create_app()
from fastapi.testclient import TestClient
with TestClient(app) as c:
 r=c.get('/healthz',headers={'Authorization':'Bearer '+'a'*64})
 assert r.status_code==200,r.text
 assert r.json()['providerStatus']=='ready',r.text
 r=c.get('/api/v1/search',headers={'Authorization':'Bearer '+'a'*64,'X-BOAA-Outbound-Proxy':'direct'})
 assert r.status_code==200 and r.json()['value']==42,r.text
print('native imports and synthetic provider health pass')
'''])
    elif a.component == 'updater':
        execute('Docker CLI, Compose and flock', 'sh', ['-ec', 'docker --version; docker compose version; flock -n /tmp/test.lock node --check scripts/release/updater.mjs'])
    elif a.component == 'web':
        execute('nginx configuration and served licenses/runtime config', 'sh', ['-ec', '/docker-entrypoint.d/40-boaa-runtime-config.sh; nginx -t; test -s /usr/share/nginx/html/index.html; test -s /usr/share/nginx/html/licenses/LICENSE; test -s /usr/share/nginx/html/licenses/server-sources.md; test -s /usr/share/nginx/html/runtime-config.js'])
    else:
        raise ValueError('unknown_component')
    a.output.mkdir(parents=True, exist_ok=True)
    (a.output / (a.component + '-' + expected + '-smoke.json')).write_text(json.dumps({
        'format': 1, 'component': a.component, 'architecture': expected,
        'imageId': info['Id'], 'revision': info['Config'].get('Labels', {}).get('org.opencontainers.image.revision'),
        'nativeHost': platform.machine(), 'tests': results,
    }, indent=2) + '\n')


if __name__ == '__main__':
    main()

"""Internal-only CPU inference adapter. Never accepts code or model paths from requests."""
import io
import json
import math
import os
from pathlib import Path
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from helper import TextToSpeech, load_cfgs, load_onnx_all, load_text_processor, load_voice_style
from install import MANIFEST, install, verify

MODEL_ID = 'supertonic-3-ko'
root = Path(os.environ.get('MODEL_DIRECTORY', '/models'))
model = root / MANIFEST['revision']
if os.environ.get('MODEL_AUTO_INSTALL', 'false') == 'true':
    model = install(root)
else:
    verify(model)
options = ort.SessionOptions()
options.intra_op_num_threads = 4
options.inter_op_num_threads = 1
options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
options.add_session_config_entry('session.intra_op.allow_spinning', '0')
options.add_session_config_entry('session.inter_op.allow_spinning', '0')
onnx = str(model / 'onnx')
tts = TextToSpeech(load_cfgs(onnx), load_text_processor(onnx), *load_onnx_all(onnx, options, ['CPUExecutionProvider']))
styles = {f'{gender}{index}': load_voice_style([str(model / 'voice_styles' / f'{gender}{index}.json')]) for gender in ['F', 'M'] for index in range(1, 6)}
lock = threading.Lock()
slots = threading.BoundedSemaphore(4)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Do not log source text or book data.

    def send(self, status, body, content_type='application/json'):
        data = json.dumps(body, ensure_ascii=False).encode() if not isinstance(body, bytes) else body
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path == '/health':
            return self.send(200, {'ready': True, 'modelId': MODEL_ID, 'revision': MANIFEST['revision']})
        if self.path == '/voices':
            return self.send(200, {'modelId': MODEL_ID, 'revision': MANIFEST['revision'], 'voices': [
                {'id': key, 'label': f"한국어 {'여성' if key[0] == 'F' else '남성'} {key[1:]}", 'lang': 'ko-KR'} for key in styles
            ]})
        self.send(404, {'error': 'not_found'})

    def do_POST(self):
        if self.path != '/synthesize':
            return self.send(404, {'error': 'not_found'})
        self.connection.settimeout(60)
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 32768:
                return self.send(413, {'error': 'invalid_size'})
            body = json.loads(self.rfile.read(size))
            text, voice, speed = body.get('text'), body.get('voiceId'), body.get('speed', 1)
            if (body.get('modelId') != MODEL_ID or not isinstance(text, str) or not text.strip()
                    or len(text) > 1000 or voice not in styles or not isinstance(speed, (int, float))
                    or not math.isfinite(speed) or not 0.5 <= speed <= 2.5 or body.get('format', 'wav') != 'wav'):
                return self.send(400, {'error': 'invalid_input'})
            if not slots.acquire(blocking=False):
                return self.send(429, {'error': 'busy'})
            try:
                with lock:
                    audio, duration = tts(text, 'ko', styles[voice], total_step=8, speed=speed)
                samples = audio[0, :int(tts.sample_rate * duration[0].item())]
                output = io.BytesIO()
                with wave.open(output, 'wb') as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(tts.sample_rate)
                    wav.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())
                self.send(200, output.getvalue(), 'audio/wav')
            finally:
                slots.release()
        except (ValueError, TypeError, KeyError):
            self.send(400, {'error': 'invalid_input'})
        except Exception:
            self.send(500, {'error': 'synthesis_failed'})


ThreadingHTTPServer(('0.0.0.0', 9010), Handler).serve_forever()

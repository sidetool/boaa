"""Native S3 signing, persistence and health test using only disposable Docker resources."""
import argparse
import datetime
import hashlib
import hmac
import json
import pathlib
import subprocess
import time
import urllib.error
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--image', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
name = 'boaa-minio-smoke-' + uuid.uuid4().hex[:12]
volume = name + '-data'
access, secret = 'boaa-smoke', uuid.uuid4().hex

def docker(*command):
    return subprocess.check_output(['docker', *command], text=True, timeout=120).strip()

def request(method, route, body=b'', key=secret):
    now = datetime.datetime.now(datetime.timezone.utc)
    day, stamp = now.strftime('%Y%m%d'), now.strftime('%Y%m%dT%H%M%SZ')
    digest = hashlib.sha256(body).hexdigest()
    headers = {'host': host, 'x-amz-content-sha256': digest, 'x-amz-date': stamp}
    signed = ';'.join(sorted(headers))
    canonical_headers = ''.join(k + ':' + headers[k] + '\n' for k in sorted(headers))
    canonical = '\n'.join([method, route, '', canonical_headers, signed, digest])
    scope = day + '/us-east-1/s3/aws4_request'
    to_sign = '\n'.join(['AWS4-HMAC-SHA256', stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    signing_key = ('AWS4' + key).encode()
    for part in [day, 'us-east-1', 's3', 'aws4_request']:
        signing_key = hmac.new(signing_key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(signing_key, to_sign.encode(), hashlib.sha256).hexdigest()
    headers['Authorization'] = 'AWS4-HMAC-SHA256 Credential=' + access + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + signature
    req = urllib.request.Request('http://' + host + route, data=body if method == 'PUT' else None, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=10) as response:
        return response.read()

def ready():
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            docker('exec', name, '/usr/local/bin/minio-health')
            return
        except subprocess.CalledProcessError:
            time.sleep(1)
    raise RuntimeError('MinIO health deadline exceeded')

try:
    docker('volume', 'create', volume)
    docker('run', '-d', '--name', name, '-p', '127.0.0.1::9000',
           '-e', 'MINIO_ROOT_USER=' + access, '-e', 'MINIO_ROOT_PASSWORD=' + secret,
           '-v', volume + ':/data', args.image)
    host = docker('port', name, '9000/tcp').splitlines()[0]
    ready()
    request('PUT', '/boaa-smoke')
    payload = (b'boaa S3 persistence fixture\x00\xff\n' * 65536)
    request('PUT', '/boaa-smoke/object', payload)
    assert request('GET', '/boaa-smoke/object') == payload
    try:
        request('GET', '/boaa-smoke/object', key='incorrect-secret')
        raise AssertionError('Invalid signature accepted')
    except urllib.error.HTTPError as error:
        assert error.code == 403, error.code
    docker('restart', name)
    # Docker may allocate a different ephemeral host port when restarting.
    host = docker('port', name, '9000/tcp').splitlines()[0]
    ready()
    assert request('GET', '/boaa-smoke/object') == payload
    info = json.loads(docker('image', 'inspect', args.image))[0]
    version = docker('run', '--rm', args.image, '--version')
    assert '2025-10-15T17-29-55Z' in version, version
    result = {'passed': True, 'architecture': info['Architecture'], 'imageId': info['Id'],
              'version': version, 'tests': ['health', 'signed-bucket-create', 'signed-put-get', 'bad-signature-403', 'restart-persistence'],
              'payloadSha256': hashlib.sha256(payload).hexdigest()}
    pathlib.Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
except BaseException:
    subprocess.run(['docker', 'logs', '--tail', '80', name], check=False)
    raise
finally:
    subprocess.run(['docker', 'rm', '-f', name], check=False, stdout=subprocess.DEVNULL)
    subprocess.run(['docker', 'volume', 'rm', volume], check=False, stdout=subprocess.DEVNULL)

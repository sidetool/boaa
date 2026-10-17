import { Copy } from 'lucide-react';
import { useServerAccessLink } from './use-server-access-link';
import './server-access.css';

/** Shared by the desktop host and authenticated self-host web settings. No credentials in the QR. */
export function ServerAccessLink({ url }: { readonly url: string }) {
  const { qr, copy, message, input } = useServerAccessLink(url);
  return (
    <div className="server-access-link">
      {qr && (
        <svg
          role="img"
          aria-label="서재 접속 QR 코드"
          className="server-access-qr"
          viewBox={`0 0 ${qr.size} ${qr.size}`}
          shapeRendering="crispEdges"
        >
          <rect width={qr.size} height={qr.size} fill="#fff" />
          <path d={qr.path} fill="#000" />
        </svg>
      )}
      <p>다른 기기에서 QR 코드를 스캔한 뒤 BOAA 계정으로 로그인하세요.</p>
      <div className="server-access-address">
        <input
          ref={input}
          aria-label="다른 기기 접속 주소"
          readOnly
          value={url}
          onFocus={(event) => event.target.select()}
        />
        <button type="button" className="ghost-btn" aria-label="접속 주소 복사" onClick={() => void copy()}>
          <Copy size={20} />
        </button>
      </div>
      {message && <p role="status">{message === 'copied' ? '주소를 복사했습니다.' : '선택된 주소를 복사해 주세요.'}</p>}
    </div>
  );
}

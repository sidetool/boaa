import { Check, Copy } from 'lucide-react';
import { useServerAccessLink } from '../../../features/server-access/use-server-access-link';

/** QR on the left, the address with a copy button beside it. The QR never carries credentials. */
export function AccessLinkCard({ url }: { url: string }) {
  const { qr, copy, message, input } = useServerAccessLink(url);
  return (
    <div className="un-access-card">
      {qr && (
        <svg
          role="img"
          aria-label="서재 접속 QR 코드"
          className="un-access-qr"
          viewBox={`0 0 ${qr.size} ${qr.size}`}
          shapeRendering="crispEdges"
        >
          <rect width={qr.size} height={qr.size} fill="#fff" />
          <path d={qr.path} fill="#000" />
        </svg>
      )}
      <div className="un-access-body">
        <p>다른 기기 카메라로 QR을 찍거나 주소를 열고, BOAA 계정으로 로그인하세요.</p>
        <div className="un-access-address">
          <input
            ref={input}
            className="un-input"
            aria-label="다른 기기 접속 주소"
            readOnly
            value={url}
            onFocus={(event) => event.target.select()}
          />
          <button type="button" className="un-btn is-ghost" onClick={() => void copy()}>
            {message === 'copied' ? <Check size={16} /> : <Copy size={16} />}
            {message === 'copied' ? '복사됨' : '복사'}
          </button>
        </div>
        {message === 'select' && (
          <small role="status" className="un-access-hint">
            주소를 선택해 두었어요. 직접 복사해 주세요.
          </small>
        )}
      </div>
    </div>
  );
}

import { MonitorSmartphone } from 'lucide-react';
import { EmbeddedServerSharing } from '../../../platform/EmbeddedServerSharing';
import { useRemoteAccessSettingsModel } from '../../../features/reader-settings/use-remote-access-settings-model';
import { EmptyState, Notice, PrefSection } from '../../components/prefs';
import { AccessLinkCard } from './AccessLinkCard';

/** 원격 접속: open this library from another device. Desktop hosts keep their own sharing controls. */
export function RemoteAccessPage({ serverApiBaseUrl }: { serverApiBaseUrl?: string }) {
  const { embedded, address, loopback } = useRemoteAccessSettingsModel(serverApiBaseUrl);
  if (embedded) return <EmbeddedServerSharing {...embedded} inline />;
  if (!address)
    return (
      <EmptyState
        icon={<MonitorSmartphone size={22} />}
        title="이 서재는 이 브라우저에만 있어요"
        body="다른 기기에서 열려면 개인 서버나 데스크톱 앱의 서재를 쓰세요."
      />
    );
  return (
    <PrefSection title="다른 기기에서 이 서재 열기" hint="같은 서버에 접속하면 이 서재를 그대로 쓸 수 있어요.">
      {loopback ? (
        <Notice tone="warning">
          지금 주소는 이 기기에서만 열려요. 다른 기기에서는 서버의 내부망 주소나 공개 도메인으로 접속해 주세요.
        </Notice>
      ) : (
        <AccessLinkCard url={address.href} />
      )}
      <Notice>
        서버가 켜져 있어야 해요. 같은 와이파이에서는 내부망 주소로, 밖에서는 서버에 설정한 HTTPS 주소로 접속하세요.
      </Notice>
    </PrefSection>
  );
}

import { ExtensionIcon } from '../../features/extensions/ExtensionIcon';
export function ExtensionAvatar(props: { name: string; iconUrl?: string }) {
  return <ExtensionIcon {...props} className="un-ext-avatar" />;
}

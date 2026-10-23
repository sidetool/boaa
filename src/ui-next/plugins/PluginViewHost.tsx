import { useProductPlugins } from '../../extensions/platform/PlatformPluginProvider';
import { PluginViewSheet } from './PluginViewSheet';
import { closePluginView, usePluginViewRoute } from './view-route';

/** Renders the routed plugin view; settings keeps its own sheet. */
export function PluginViewHost() {
  const route = usePluginViewRoute();
  const { session } = useProductPlugins();
  if (!route || !session) return null;
  return (
    <PluginViewSheet
      key={route.key}
      session={session}
      id={route.pluginId}
      view={route.view}
      title={route.title}
      close={closePluginView}
    />
  );
}

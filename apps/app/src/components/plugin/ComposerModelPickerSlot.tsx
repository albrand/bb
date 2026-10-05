import {
  useOptionalPluginComposerStaticView,
  composerScopeIdentity,
  usePluginComposerHost,
} from "./plugin-composer-host";
import { useResolvedComposerModelPickers } from "./composer-slot-hooks";
import { PluginSlotMount } from "./PluginSlotMount";

export function ComposerModelPickerSlot({
  providerId,
}: {
  providerId: string;
}) {
  const view = useOptionalPluginComposerStaticView();
  const host = usePluginComposerHost();
  const contributions = useResolvedComposerModelPickers(
    view?.scope.kind ?? null,
  );
  if (view === undefined) return null;
  return contributions.map(({ key, pluginId, component: Component }) => (
    <PluginSlotMount
      key={key}
      pluginId={pluginId}
      slotKind="composerModelPicker"
      slotId={key}
      instanceId={host?.textEffectKey ?? composerScopeIdentity(view.scope)}
    >
      <Component providerId={providerId} />
    </PluginSlotMount>
  ));
}

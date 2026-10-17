import { useEffect, useState } from 'react';
import type { ExternalSourceConnectionForm } from '../../external-sources/contracts';
import type { ExternalSourceController, ExternalSourceView } from './external-source-controller-contract';

function initialFormValues(form: ExternalSourceConnectionForm | undefined): Record<string, string> {
  return Object.fromEntries(form?.fields.map((field) => [field.id, field.defaultValue ?? '']) ?? []);
}

export function useSourceConnectionSettingsModel(source: ExternalSourceView, controller: ExternalSourceController) {
  const active = source.id === controller.activeSourceId;
  const connection = source.connection;
  const unavailable = connection.state === 'unavailable';
  const connected = connection.state === 'connected';
  const needsReauthorization = connection.state === 'reauthorization_required';
  const [values, setValues] = useState<Record<string, string>>(() => initialFormValues(source.connectionForm));
  const [manageExtensions, setManageExtensions] = useState(false);

  useEffect(() => {
    setValues(initialFormValues(source.connectionForm));
  }, [source.connectionForm, source.id]);

  const submitConnection = () => controller.connect(values);

  return {
    active,
    connection,
    unavailable,
    connected,
    needsReauthorization,
    values,
    setValues,
    manageExtensions,
    setManageExtensions,
    submitConnection,
    busy: controller.busy,
    fields: source.connectionForm?.fields ?? [],
    select: () => controller.selectSource(source.id),
    disconnect: () => controller.disconnect(),
  };
}
export type SourceConnectionSettingsModel = ReturnType<typeof useSourceConnectionSettingsModel>;

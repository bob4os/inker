import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Input, Modal, Select } from '../common';
import { modelService } from '../../services/api';
import { useNotification } from '../../contexts/NotificationContext';
import { depthLabel, panelDepthFor, PANEL_DEPTHS } from '../../utils/panelDepth';
import type { DeviceModel, DeviceModelFormData, ModelSyncResult } from '../../types';

const EMPTY_FORM: DeviceModelFormData = {
  name: '',
  label: '',
  width: 800,
  height: 480,
  description: '',
  mimeType: 'image/png',
  bitDepth: 1,
  rotation: 0,
  offsetX: 0,
  offsetY: 0,
  scaleFactor: 1.0,
};

/**
 * Device Models editor
 *
 * Full CRUD over the display models a device can be assigned to: resolution, image format and
 * panel depth. Models with devices attached cannot be deleted (the API rejects it).
 */
export function DeviceModels() {
  const { showNotification } = useNotification();
  const [models, setModels] = useState<DeviceModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [editing, setEditing] = useState<DeviceModel | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [form, setForm] = useState<DeviceModelFormData>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof DeviceModelFormData, string>>>({});
  const [deleting, setDeleting] = useState<DeviceModel | null>(null);
  /** Set when a sync would overwrite existing models — drives the confirmation dialog. */
  const [syncPreview, setSyncPreview] = useState<ModelSyncResult | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setModels(await modelService.getAll());
    } catch (error) {
      showNotification('error', error instanceof Error ? error.message : 'Failed to load models');
    } finally {
      setIsLoading(false);
    }
  }, [showNotification]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setErrors({});
    setIsFormOpen(true);
  };

  const openEdit = (model: DeviceModel) => {
    setEditing(model);
    setForm({
      name: model.name,
      label: model.label,
      width: model.width,
      height: model.height,
      description: model.description ?? '',
      mimeType: model.mimeType,
      bitDepth: model.bitDepth ?? 1,
      rotation: model.rotation ?? 0,
      offsetX: model.offsetX ?? 0,
      offsetY: model.offsetY ?? 0,
      scaleFactor: model.scaleFactor ?? 1.0,
    });
    setErrors({});
    setIsFormOpen(true);
  };

  const validate = (): boolean => {
    const next: Partial<Record<keyof DeviceModelFormData, string>> = {};
    if (!form.name.trim()) next.name = 'Required';
    else if (!/^[a-z0-9_]+$/.test(form.name)) next.name = 'Lowercase letters, digits and underscores only';
    if (!form.label.trim()) next.label = 'Required';
    if (!Number.isInteger(form.width) || form.width < 1) next.width = 'Must be a positive whole number';
    if (!Number.isInteger(form.height) || form.height < 1) next.height = 'Must be a positive whole number';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;

    // colors is derived from the depth so the two can never drift apart.
    const depth = panelDepthFor(form.bitDepth);
    const payload: DeviceModelFormData = {
      ...form,
      name: form.name.trim(),
      label: form.label.trim(),
      description: form.description?.trim() || undefined,
      colors: depth.colors,
    };

    setIsSaving(true);
    try {
      if (editing) {
        await modelService.update(editing.id, payload);
        showNotification('success', `Model "${payload.label}" updated`);
      } else {
        await modelService.create(payload);
        showNotification('success', `Model "${payload.label}" created`);
      }
      setIsFormOpen(false);
      await load();
    } catch (error) {
      showNotification('error', error instanceof Error ? error.message : 'Failed to save model');
    } finally {
      setIsSaving(false);
    }
  };

  const syncSummary = (result: ModelSyncResult) =>
    `${result.created.length} added, ${result.updated.length} updated, ${result.unchanged} already current`;

  /**
   * Preview first. Adding models nobody has is harmless, so that applies straight away — but if the
   * feed would overwrite models that already exist with different values, show what would be lost
   * and let the user decide.
   */
  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const preview = await modelService.sync(true);
      if (preview.updated.length === 0) {
        const result = await modelService.sync();
        showNotification('success', `Synced ${result.total} models — ${syncSummary(result)}`);
        await load();
        return;
      }
      setSyncPreview(preview);
    } catch (error) {
      showNotification('error', error instanceof Error ? error.message : 'Model sync failed');
    } finally {
      setIsSyncing(false);
    }
  };

  const applySync = async () => {
    setIsSyncing(true);
    try {
      const result = await modelService.sync();
      showNotification('success', `Synced ${result.total} models — ${syncSummary(result)}`);
      setSyncPreview(null);
      await load();
    } catch (error) {
      showNotification('error', error instanceof Error ? error.message : 'Model sync failed');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setIsSaving(true);
    try {
      await modelService.delete(deleting.id);
      showNotification('success', `Model "${deleting.label}" deleted`);
      setDeleting(null);
      await load();
    } catch (error) {
      showNotification('error', error instanceof Error ? error.message : 'Failed to delete model');
    } finally {
      setIsSaving(false);
    }
  };

  const setField = <K extends keyof DeviceModelFormData>(key: K, value: DeviceModelFormData[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const selectedDepth = panelDepthFor(form.bitDepth);

  return (
    <>
      <Card padding="none">
        <div className="flex items-center justify-between gap-4 p-6 border-b border-border-light">
          <div>
            <h3 className="text-sm font-medium text-text-primary">Display models</h3>
            <p className="text-sm text-text-secondary mt-1">
              Resolution, image format and panel depth for the displays you connect. Devices pick a
              model on the device page. Sync pulls TRMNL's published model list — it matches by
              name, so your own models are left alone.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={handleSync} isLoading={isSyncing}>
              Sync from TRMNL
            </Button>
            <Button size="sm" onClick={openCreate}>Add model</Button>
          </div>
        </div>

        {isLoading ? (
          <div className="p-6 text-text-secondary">Loading…</div>
        ) : models.length === 0 ? (
          <div className="p-6 text-text-secondary">No models yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted border-b border-border-light">
                  <th className="px-6 py-3 font-medium">Model</th>
                  <th className="px-6 py-3 font-medium">Resolution</th>
                  <th className="px-6 py-3 font-medium">Format</th>
                  <th className="px-6 py-3 font-medium">Depth</th>
                  <th className="px-6 py-3 font-medium">Devices</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.id} className="border-b border-border-light last:border-0">
                    <td className="px-6 py-3">
                      <div className="font-medium text-text-primary">{model.label}</div>
                      <div className="text-xs font-mono text-text-muted">{model.name}</div>
                    </td>
                    <td className="px-6 py-3 font-mono text-text-secondary">
                      {model.width}×{model.height}
                    </td>
                    <td className="px-6 py-3 text-text-secondary">
                      {model.mimeType === 'image/bmp' ? 'BMP' : 'PNG'}
                    </td>
                    <td className="px-6 py-3 text-text-secondary">{depthLabel(model.bitDepth)}</td>
                    <td className="px-6 py-3 text-text-secondary">{model._count?.devices ?? 0}</td>
                    <td className="px-6 py-3">
                      <div className="flex justify-end gap-2">
                        <Button size="xs" variant="outline" onClick={() => openEdit(model)}>
                          Edit
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setDeleting(model)}
                          disabled={(model._count?.devices ?? 0) > 0}
                          title={
                            (model._count?.devices ?? 0) > 0
                              ? 'In use by a device — reassign it first'
                              : undefined
                          }
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        title={editing ? `Edit ${editing.label}` : 'Add display model'}
        size="lg"
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setIsFormOpen(false)} disabled={isSaving}>
              Cancel
            </Button>
            <Button onClick={handleSave} isLoading={isSaving}>
              {editing ? 'Save changes' : 'Create model'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Name"
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
              error={errors.name}
              helperText="Machine name, e.g. mono4_png"
              placeholder="mono4_png"
            />
            <Input
              label="Label"
              value={form.label}
              onChange={(e) => setField('label', e.target.value)}
              error={errors.label}
              helperText="Shown in the device model picker"
              placeholder="Monochrome 4-gray"
            />
          </div>

          <Input
            label="Description"
            value={form.description ?? ''}
            onChange={(e) => setField('description', e.target.value)}
            placeholder="Optional notes about this panel"
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Width (px)"
              type="number"
              min={1}
              value={form.width}
              onChange={(e) => setField('width', parseInt(e.target.value, 10) || 0)}
              error={errors.width}
            />
            <Input
              label="Height (px)"
              type="number"
              min={1}
              value={form.height}
              onChange={(e) => setField('height', parseInt(e.target.value, 10) || 0)}
              error={errors.height}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Image format"
              value={form.mimeType}
              onChange={(e) => setField('mimeType', e.target.value)}
              helperText="BMP is for firmware that rejects PNG (TRMNL OG / DIY kits)"
            >
              <option value="image/png">PNG</option>
              <option value="image/bmp">BMP</option>
            </Select>
            <Select
              label="Panel depth"
              value={String(form.bitDepth)}
              onChange={(e) => setField('bitDepth', parseInt(e.target.value, 10))}
            >
              {PANEL_DEPTHS.map((depth) => (
                <option key={depth.value} value={depth.value}>
                  {depth.label}
                </option>
              ))}
            </Select>
          </div>

          <p className="text-sm text-text-secondary bg-bg-muted rounded-xl p-3">
            {selectedDepth.hint}
          </p>

          <details className="rounded-xl border border-border-light p-4">
            <summary className="cursor-pointer text-sm font-semibold text-text-secondary">
              Advanced
            </summary>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
              <Input
                label="Rotation (°)"
                type="number"
                value={form.rotation ?? 0}
                onChange={(e) => setField('rotation', parseInt(e.target.value, 10) || 0)}
              />
              <Input
                label="Offset X"
                type="number"
                value={form.offsetX ?? 0}
                onChange={(e) => setField('offsetX', parseInt(e.target.value, 10) || 0)}
              />
              <Input
                label="Offset Y"
                type="number"
                value={form.offsetY ?? 0}
                onChange={(e) => setField('offsetY', parseInt(e.target.value, 10) || 0)}
              />
              <Input
                label="Scale"
                type="number"
                step="0.1"
                value={form.scaleFactor ?? 1}
                onChange={(e) => setField('scaleFactor', parseFloat(e.target.value) || 1)}
              />
            </div>
          </details>
        </div>
      </Modal>

      <Modal
        isOpen={syncPreview !== null}
        onClose={() => setSyncPreview(null)}
        title="Sync will overwrite existing models"
        size="lg"
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setSyncPreview(null)} disabled={isSyncing}>
              Cancel
            </Button>
            <Button variant="warning" onClick={applySync} isLoading={isSyncing}>
              Overwrite and sync
            </Button>
          </div>
        }
      >
        {syncPreview && (
          <div className="space-y-4">
            <p className="text-text-secondary">
              {syncPreview.created.length > 0 && (
                <>
                  <span className="font-medium text-text-primary">{syncPreview.created.length}</span>
                  {' '}new model{syncPreview.created.length === 1 ? '' : 's'} would be added, and{' '}
                </>
              )}
              <span className="font-medium text-text-primary">{syncPreview.updated.length}</span>
              {' '}existing model{syncPreview.updated.length === 1 ? '' : 's'} would be replaced with
              the feed's values. Models the feed doesn't list are never touched.
            </p>

            <div className="max-h-72 overflow-y-auto rounded-xl border border-border-light divide-y divide-border-light">
              {syncPreview.updated.map((model) => (
                <div key={model.name} className="p-3">
                  <div className="font-medium text-text-primary">{model.label}</div>
                  <div className="text-xs font-mono text-text-muted mb-2">{model.name}</div>
                  <ul className="space-y-1">
                    {model.changes.map((change) => (
                      <li key={change.field} className="text-sm text-text-secondary">
                        <span className="font-mono text-xs">{change.field}</span>{': '}
                        <span className="line-through">{String(change.from ?? '—')}</span>
                        {' → '}
                        <span className="font-medium text-text-primary">{String(change.to ?? '—')}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <p className="text-xs text-text-muted">
              Source: <span className="font-mono">{syncPreview.source}</span>
            </p>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete model"
        size="sm"
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={isSaving}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} isLoading={isSaving}>
              Delete
            </Button>
          </div>
        }
      >
        <p className="text-text-secondary">
          Delete <span className="font-medium text-text-primary">{deleting?.label}</span>? Devices
          using it must be reassigned first.
        </p>
      </Modal>
    </>
  );
}

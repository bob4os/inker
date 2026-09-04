import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CreateModelDto } from './dto/create-model.dto';
import { UpdateModelDto } from './dto/update-model.dto';
import { wrapListResponse } from '../common/utils/response.util';

/** TRMNL's public Models API — the same feed other BYOS servers sync their model list from. */
const DEFAULT_MODELS_API_URL = 'https://usetrmnl.com/api/models';

/**
 * A model entry as published by a Models API feed. TRMNL's speaks snake_case and wraps the list in
 * `data`; fields beyond these (palette_ids, css, preview_white_point, …) describe TRMNL's own
 * renderer and are ignored.
 */
interface ExternalModel {
  name?: string;
  label?: string;
  description?: string;
  width?: number;
  height?: number;
  colors?: number;
  bit_depth?: number;
  mime_type?: string;
  scale_factor?: number;
  rotation?: number;
  offset_x?: number;
  offset_y?: number;
  kind?: string;
}

/** One field a sync would change on an existing model. */
export interface ModelFieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ModelSyncResult {
  /** The feed the models came from. */
  source: string;
  /** Entries in the feed. */
  total: number;
  /** Nothing was written — this is a preview of what a sync would do. */
  dryRun: boolean;
  /** Names that don't exist locally yet and would simply be added. */
  created: string[];
  /**
   * Existing models the feed would change, with the fields it would overwrite. Models that match
   * the feed already are counted in `unchanged` instead, so this list is exactly "what you'd lose".
   */
  updated: { name: string; label: string; changes: ModelFieldChange[] }[];
  /** Existing models the feed agrees with — rewriting them would be a no-op. */
  unchanged: number;
}

/** The model columns a sync writes, mapped from a feed entry. */
function toModelRow(external: ExternalModel) {
  const bitDepth = external.bit_depth ?? 1;
  return {
    label: external.label ?? external.name ?? '',
    width: external.width ?? 800,
    height: external.height ?? 480,
    description: external.description ?? null,
    // colors follows the depth when the feed doesn't say (2, 4, 16, 256 …)
    colors: external.colors ?? Math.min(256, 2 ** bitDepth),
    bitDepth,
    mimeType: external.mime_type ?? 'image/png',
    scaleFactor: external.scale_factor ?? 1.0,
    rotation: external.rotation ?? 0,
    offsetX: external.offset_x ?? 0,
    offsetY: external.offset_y ?? 0,
    kind: external.kind ?? 'terminus',
  };
}

/** Fields where the feed's value differs from what's stored — empty means the sync is a no-op. */
function diffModel(existing: Record<string, unknown>, row: Record<string, unknown>): ModelFieldChange[] {
  return Object.entries(row)
    .filter(([field, to]) => {
      const from = existing[field] ?? null;
      // description is nullable; treat null and '' as the same absence
      if (from === null && (to === null || to === '')) return false;
      return from !== to;
    })
    .map(([field, to]) => ({ field, from: existing[field] ?? null, to }));
}

@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  /**
   * Create a new device model
   */
  async create(createModelDto: CreateModelDto) {
    // Check if model with same name exists
    const existing = await this.prisma.model.findUnique({
      where: { name: createModelDto.name },
    });

    if (existing) {
      throw new BadRequestException('Model with this name already exists');
    }

    const model = await this.prisma.model.create({
      data: {
        name: createModelDto.name,
        label: createModelDto.label,
        width: createModelDto.width,
        height: createModelDto.height,
        description: createModelDto.description,
        mimeType: createModelDto.mimeType || 'image/png',
        colors: createModelDto.colors || 2,
        bitDepth: createModelDto.bitDepth || 1,
        rotation: createModelDto.rotation || 0,
        offsetX: createModelDto.offsetX || 0,
        offsetY: createModelDto.offsetY || 0,
        kind: createModelDto.kind || 'terminus',
        scaleFactor: createModelDto.scaleFactor || 1.0,
      },
    });

    this.logger.log(`Model created: ${model.name}`);
    return model;
  }

  /**
   * Find all models
   */
  async findAll() {
    const models = await this.prisma.model.findMany({
      include: {
        _count: {
          select: {
            devices: true,
            screens: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return wrapListResponse(models);
  }

  /**
   * Find one model by ID
   */
  async findOne(id: number) {
    const model = await this.prisma.model.findUnique({
      where: { id },
      include: {
        devices: {
          select: {
            id: true,
            name: true,
            macAddress: true,
            isActive: true,
          },
        },
        screens: {
          select: {
            id: true,
            name: true,
            imageUrl: true,
          },
          take: 10,
        },
        _count: {
          select: {
            devices: true,
            screens: true,
          },
        },
      },
    });

    if (!model) {
      throw new NotFoundException('Model not found');
    }

    return model;
  }

  /**
   * Find model by name
   */
  async findByName(name: string) {
    return this.prisma.model.findUnique({
      where: { name },
    });
  }

  /**
   * Update model
   */
  async update(id: number, updateModelDto: UpdateModelDto) {
    const model = await this.prisma.model.findUnique({
      where: { id },
    });

    if (!model) {
      throw new NotFoundException('Model not found');
    }

    // Check name uniqueness if changing
    if (updateModelDto.name && updateModelDto.name !== model.name) {
      const existing = await this.prisma.model.findUnique({
        where: { name: updateModelDto.name },
      });

      if (existing) {
        throw new BadRequestException('Model with this name already exists');
      }
    }

    const updated = await this.prisma.model.update({
      where: { id },
      data: {
        name: updateModelDto.name,
        label: updateModelDto.label,
        width: updateModelDto.width,
        height: updateModelDto.height,
        description: updateModelDto.description,
        mimeType: updateModelDto.mimeType,
        colors: updateModelDto.colors,
        bitDepth: updateModelDto.bitDepth,
        rotation: updateModelDto.rotation,
        offsetX: updateModelDto.offsetX,
        offsetY: updateModelDto.offsetY,
        kind: updateModelDto.kind,
        scaleFactor: updateModelDto.scaleFactor,
      },
    });

    this.logger.log(`Model updated: ${updated.name}`);
    return updated;
  }

  /**
   * Delete model
   */
  async remove(id: number) {
    const model = await this.prisma.model.findUnique({
      where: { id },
      include: {
        _count: {
          select: { devices: true },
        },
      },
    });

    if (!model) {
      throw new NotFoundException('Model not found');
    }

    // Prevent deletion if devices are using this model
    if (model._count.devices > 0) {
      throw new BadRequestException(
        `Cannot delete model: ${model._count.devices} device(s) are using it`,
      );
    }

    await this.prisma.model.delete({
      where: { id },
    });

    this.logger.log(`Model deleted: ${model.name}`);
    return { message: 'Model deleted successfully' };
  }

  /**
   * Sync the model list from a Models API feed (TRMNL's by default, or MODELS_API_URL).
   *
   * User-triggered: Inker makes no outbound call until this runs. Models are matched by name —
   * existing ones keep their id (so devices stay linked) and have their specs refreshed, new ones
   * are created. Nothing is deleted, so models you added yourself survive a sync untouched, as
   * long as their name isn't one the feed also publishes.
   *
   * `dryRun` performs the fetch and the comparison but writes nothing, so the UI can warn about
   * exactly which of your models a sync would overwrite (and in which fields) before you commit.
   */
  async syncFromApi(dryRun = false): Promise<ModelSyncResult> {
    const url = this.config.get<string>('models.apiUrl') || DEFAULT_MODELS_API_URL;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let body: unknown;
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'Inker-E-Ink-Display' },
      });
      if (!response.ok) {
        throw new BadRequestException(
          `Models API returned ${response.status} ${response.statusText}`,
        );
      }
      body = await response.json();
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Model sync failed (${url}): ${reason}`);
      throw new BadRequestException(`Could not reach the models API: ${reason}`);
    } finally {
      clearTimeout(timeoutId);
    }

    // TRMNL wraps the list in `data`; a bare array or Inker's own { data: { items } } shape is
    // accepted too, so a self-hosted feed can be simpler.
    const wrapped = body as { data?: unknown };
    const inner = wrapped?.data;
    const externalModels: ExternalModel[] = Array.isArray(body)
      ? body
      : Array.isArray(inner)
        ? inner
        : Array.isArray((inner as { items?: unknown })?.items)
          ? ((inner as { items: ExternalModel[] }).items)
          : [];

    if (externalModels.length === 0) {
      throw new BadRequestException('Models API returned no usable models');
    }

    const created: string[] = [];
    const updated: ModelSyncResult['updated'] = [];
    let unchanged = 0;

    for (const external of externalModels) {
      if (!external?.name) {
        this.logger.warn('Skipping models API entry with no name');
        continue;
      }

      const row = toModelRow(external);
      const existing = await this.prisma.model.findUnique({
        where: { name: external.name },
      });

      if (!existing) {
        created.push(external.name);
        if (!dryRun) {
          await this.prisma.model.create({ data: { name: external.name, ...row } });
        }
        continue;
      }

      const changes = diffModel(existing as unknown as Record<string, unknown>, row);
      if (changes.length === 0) {
        unchanged++;
        continue;
      }

      updated.push({ name: external.name, label: existing.label, changes });
      if (!dryRun) {
        await this.prisma.model.update({ where: { id: existing.id }, data: row });
      }
    }

    this.logger.log(
      `Model sync from ${url} ${dryRun ? 'preview' : 'complete'} — ` +
        `${created.length} new, ${updated.length} changed, ${unchanged} already current`,
    );

    return {
      source: url,
      total: externalModels.length,
      dryRun,
      created,
      updated,
      unchanged,
    };
  }
}

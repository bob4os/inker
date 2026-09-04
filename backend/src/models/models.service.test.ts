import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ModelsService } from './models.service';
import { createMockPrisma, MockPrisma } from '../test/mocks/prisma.mock';

describe('ModelsService', () => {
  let service: ModelsService;
  let mockPrisma: MockPrisma;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    // ConfigService only feeds the models-API URL for syncFromApi()
    const mockConfig = { get: () => undefined };
    service = new ModelsService(mockPrisma as any, mockConfig as any);
  });

  // ─── create ──────────────────────────────────────────────────────────

  describe('create()', () => {
    it('should throw BadRequestException when name already exists', async () => {
      mockPrisma.model.findUnique.mockResolvedValue({ id: 1, name: 'TRMNL' });
      await expect(
        service.create({ name: 'TRMNL', width: 800, height: 480 } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create model when name is unique', async () => {
      mockPrisma.model.findUnique.mockResolvedValue(null);
      const created = { id: 1, name: 'NewModel', width: 800, height: 480 };
      mockPrisma.model.create.mockResolvedValue(created);

      const result = await service.create({
        name: 'NewModel',
        width: 800,
        height: 480,
      } as any);
      expect(result).toEqual(created);
      expect(mockPrisma.model.create.calls).toHaveLength(1);
    });
  });

  // ─── findOne ─────────────────────────────────────────────────────────

  describe('findOne()', () => {
    it('should throw NotFoundException when not found', async () => {
      mockPrisma.model.findUnique.mockResolvedValue(null);
      await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
    });

    it('should return model when found', async () => {
      const model = { id: 1, name: 'TRMNL', devices: [], screens: [], _count: { devices: 0, screens: 0 } };
      mockPrisma.model.findUnique.mockResolvedValue(model);

      const result = await service.findOne(1);
      expect(result).toEqual(model);
    });
  });

  // ─── update ──────────────────────────────────────────────────────────

  describe('update()', () => {
    it('should throw NotFoundException when model does not exist', async () => {
      mockPrisma.model.findUnique.mockResolvedValue(null);
      await expect(service.update(999, { name: 'X' } as any)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when changing to an existing name', async () => {
      let callCount = 0;
      mockPrisma.model.findUnique.mockImplementation((...args: any[]) => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ id: 1, name: 'OldName' });
        return Promise.resolve({ id: 2, name: 'TakenName' }); // conflict
      });

      await expect(service.update(1, { name: 'TakenName' } as any)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── remove ──────────────────────────────────────────────────────────

  describe('remove()', () => {
    it('should throw NotFoundException when model does not exist', async () => {
      mockPrisma.model.findUnique.mockResolvedValue(null);
      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when devices are using the model', async () => {
      mockPrisma.model.findUnique.mockResolvedValue({
        id: 1,
        name: 'InUse',
        _count: { devices: 3 },
      });
      await expect(service.remove(1)).rejects.toThrow(BadRequestException);
    });

    it('should delete model when no devices reference it', async () => {
      mockPrisma.model.findUnique.mockResolvedValue({
        id: 1,
        name: 'Unused',
        _count: { devices: 0 },
      });
      mockPrisma.model.delete.mockResolvedValue({});

      const result = await service.remove(1);
      expect(result).toEqual({ message: 'Model deleted successfully' });
      expect(mockPrisma.model.delete.calls).toHaveLength(1);
    });
  });

  // ─── syncFromApi ─────────────────────────────────────────────────────

  describe('syncFromApi()', () => {
    const realFetch = globalThis.fetch;

    /** A TRMNL-shaped feed: snake_case fields wrapped in `data`. */
    const feed = (models: Record<string, unknown>[]) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: models }),
    });

    const trmnlX = {
      name: 'trmnl_x',
      label: 'TRMNL X',
      width: 1872,
      height: 1404,
      colors: 16,
      bit_depth: 4,
      scale_factor: 1.8,
      mime_type: 'image/png',
      rotation: 0,
      offset_x: 0,
      offset_y: 0,
      kind: 'trmnl',
    };

    /** What trmnl_x looks like once stored — used as the "already current" baseline. */
    const storedTrmnlX = {
      id: 7,
      name: 'trmnl_x',
      label: 'TRMNL X',
      width: 1872,
      height: 1404,
      description: null,
      colors: 16,
      bitDepth: 4,
      mimeType: 'image/png',
      scaleFactor: 1.8,
      rotation: 0,
      offsetX: 0,
      offsetY: 0,
      kind: 'trmnl',
    };

    const mockFetch = (response: unknown) => {
      globalThis.fetch = (async () => response) as unknown as typeof fetch;
    };

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('maps snake_case feed fields onto Inker columns', async () => {
      mockFetch(feed([trmnlX]));
      mockPrisma.model.findUnique.mockResolvedValue(null);
      mockPrisma.model.create.mockResolvedValue({});

      const result = await service.syncFromApi();

      expect(result.created).toEqual(['trmnl_x']);
      const [{ data }] = mockPrisma.model.create.calls[0];
      // bit_depth → bitDepth is the one that matters: it drives the whole render pipeline
      expect(data.bitDepth).toBe(4);
      expect(data.colors).toBe(16);
      expect(data.mimeType).toBe('image/png');
      expect(data.scaleFactor).toBe(1.8);
      expect(data.width).toBe(1872);
    });

    it('derives colors from the depth when the feed omits it', async () => {
      mockFetch(feed([{ name: 'gray4', bit_depth: 2, width: 800, height: 480 }]));
      mockPrisma.model.findUnique.mockResolvedValue(null);
      mockPrisma.model.create.mockResolvedValue({});

      await service.syncFromApi();
      expect(mockPrisma.model.create.calls[0][0].data.colors).toBe(4);
    });

    it('accepts a bare array feed as well as the wrapped shape', async () => {
      mockFetch({ ok: true, status: 200, statusText: 'OK', json: async () => [trmnlX] });
      mockPrisma.model.findUnique.mockResolvedValue(null);
      mockPrisma.model.create.mockResolvedValue({});

      const result = await service.syncFromApi();
      expect(result.total).toBe(1);
      expect(result.created).toEqual(['trmnl_x']);
    });

    it('reports a model that already matches the feed as unchanged, and writes nothing', async () => {
      mockFetch(feed([trmnlX]));
      mockPrisma.model.findUnique.mockResolvedValue(storedTrmnlX);

      const result = await service.syncFromApi();

      expect(result.unchanged).toBe(1);
      expect(result.updated).toHaveLength(0);
      expect(mockPrisma.model.update.calls).toHaveLength(0);
    });

    it('lists the fields a sync would overwrite on a locally edited model', async () => {
      // The user changed this panel to 4 grays; the feed still says 16.
      mockFetch(feed([trmnlX]));
      mockPrisma.model.findUnique.mockResolvedValue({
        ...storedTrmnlX,
        bitDepth: 2,
        colors: 4,
        label: 'My tweaked X',
      });
      mockPrisma.model.update.mockResolvedValue({});

      const result = await service.syncFromApi();

      expect(result.updated).toHaveLength(1);
      const fields = result.updated[0].changes.map((c) => c.field).sort();
      expect(fields).toEqual(['bitDepth', 'colors', 'label']);
      const depth = result.updated[0].changes.find((c) => c.field === 'bitDepth');
      expect(depth).toEqual({ field: 'bitDepth', from: 2, to: 4 });
    });

    it('writes nothing at all in dry-run mode', async () => {
      mockFetch(feed([trmnlX, { name: 'brand_new', bit_depth: 1, width: 400, height: 300 }]));
      mockPrisma.model.findUnique.mockImplementation(async ({ where }: any) =>
        where.name === 'trmnl_x' ? { ...storedTrmnlX, bitDepth: 2 } : null,
      );

      const result = await service.syncFromApi(true);

      expect(result.dryRun).toBe(true);
      expect(result.created).toEqual(['brand_new']);
      expect(result.updated).toHaveLength(1);
      expect(mockPrisma.model.create.calls).toHaveLength(0);
      expect(mockPrisma.model.update.calls).toHaveLength(0);
    });

    it('skips feed entries with no name rather than failing the whole sync', async () => {
      mockFetch(feed([{ label: 'nameless' }, trmnlX]));
      mockPrisma.model.findUnique.mockResolvedValue(null);
      mockPrisma.model.create.mockResolvedValue({});

      const result = await service.syncFromApi();
      expect(result.created).toEqual(['trmnl_x']);
    });

    it('throws BadRequestException when the feed is unreachable', async () => {
      globalThis.fetch = (async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }) as unknown as typeof fetch;

      await expect(service.syncFromApi()).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException on a non-OK response', async () => {
      mockFetch({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) });
      await expect(service.syncFromApi()).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when the feed holds no usable models', async () => {
      mockFetch(feed([]));
      await expect(service.syncFromApi()).rejects.toThrow(BadRequestException);
    });
  });
});

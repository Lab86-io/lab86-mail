'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Cloud,
  Download,
  File,
  FileArchive,
  FileImage,
  Presentation as FilePresentation,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Grid2X2,
  HardDrive,
  List,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  Upload,
} from 'lucide-react';
import {
  type ChangeEvent,
  type DragEvent,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import {
  DocumentEditor,
  GoogleDocumentEditor,
  type GoogleEditorSource,
} from '@/components/files/DocumentEditor';
import { FileLocationPicker } from '@/components/files/FileLocationPicker';
import { OfficeEditor } from '@/components/files/OfficeEditor';
import { AppleLogo, GoogleLogo, MicrosoftLogo } from '@/components/icons/provider-logos';
import { Ring } from '@/components/loading-ui/ring';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { pushDocumentDeepLink } from '@/lib/documents/deep-link';
import type { AlbatrossDocumentRecord, DocumentKind } from '@/lib/documents/model';
import { importXlsxWorkbook, loadSpreadsheetEngine } from '@/lib/documents/odoo-spreadsheet-engine';
import { ODOO_SPREADSHEET_ENGINE } from '@/lib/documents/sheet-workbook';
import { fileMatchesType, mergeFilePages, readFilePage } from '@/lib/files/library-client';
import type { CloudFileItem, CloudFileProvider } from '@/lib/files/providers';
import { cn } from '@/lib/utils';

interface Connection {
  connectionId: string;
  provider: CloudFileProvider;
  accountEmail?: string;
  displayName?: string;
  status: 'connected' | 'error';
  lastAccessedAt?: number;
  error?: string;
}

interface ProviderStatus {
  id: CloudFileProvider;
  label: string;
  configured: boolean;
}

interface StatusResponse {
  ok: boolean;
  connections: Connection[];
  providers: ProviderStatus[];
  icloud: { mode: 'device_folder'; detail: string };
}

interface Location {
  kind: 'all' | 'albatross' | 'icloud' | 'connection';
  id: string;
  label: string;
  connection?: Connection;
}

interface FolderCrumb {
  id?: string;
  name: string;
}

interface ICloudItem extends CloudFileItem {
  handle?: any;
  localFile?: File;
}

interface DocumentFileItem extends CloudFileItem {
  documentId?: string;
  documentKind?: DocumentKind;
  officeDocumentId?: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error || `Request failed (${response.status})`);
  }
  return body as T;
}

function providerLabel(provider: CloudFileItem['provider']) {
  if (provider === 'google_drive') return 'Google Drive';
  if (provider === 'onedrive') return 'OneDrive';
  if (provider === 'icloud') return 'iCloud Drive';
  return 'Albatross';
}

function isGoogleNativeMime(value: string | null | undefined): value is GoogleEditorSource['mimeType'] {
  return (
    value === 'application/vnd.google-apps.document' ||
    value === 'application/vnd.google-apps.spreadsheet' ||
    value === 'application/vnd.google-apps.presentation'
  );
}

function ProviderMark({ provider, className }: { provider: CloudFileItem['provider']; className?: string }) {
  if (provider === 'google_drive') {
    return <GoogleLogo className={className} />;
  }
  if (provider === 'onedrive') {
    return <MicrosoftLogo className={className} />;
  }
  if (provider === 'icloud') {
    return <AppleLogo className={className} />;
  }
  return <HardDrive className={cn('size-4', className)} />;
}

function fileIcon(item: CloudFileItem) {
  const documentKind = (item as DocumentFileItem).documentKind;
  if (documentKind === 'sheet') return FileSpreadsheet;
  if (documentKind === 'deck') return FilePresentation;
  if (documentKind === 'doc') return FileText;
  if (item.isFolder) return Folder;
  if (item.mimeType?.startsWith('image/')) return FileImage;
  if (item.mimeType?.includes('zip') || item.mimeType?.includes('compressed')) {
    return FileArchive;
  }
  if (
    item.mimeType?.includes('pdf') ||
    item.mimeType?.startsWith('text/') ||
    item.mimeType?.includes('document')
  ) {
    return FileText;
  }
  return File;
}

function formatBytes(size?: number) {
  if (size === undefined) return '—';
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${Math.round(size / 1_024)} KB`;
  if (size < 1_073_741_824) {
    return `${(size / 1_048_576).toFixed(size < 10_485_760 ? 1 : 0)} MB`;
  }
  return `${(size / 1_073_741_824).toFixed(1)} GB`;
}

function formatDate(value?: number) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  }).format(value);
}

function sortItems(items: CloudFileItem[]) {
  return [...items].sort((left, right) => {
    if (left.isFolder !== right.isFolder) return left.isFolder ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

export function FilesSurface() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const officeInputRef = useRef<HTMLInputElement>(null);
  const xlsxInputRef = useRef<HTMLInputElement>(null);
  const fallbackFolderInputRef = useRef<HTMLInputElement>(null);
  const pendingFolderRef = useRef<CloudFileItem | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [locationId, setLocationId] = useState('all');
  const [layout, setLayout] = useState<'list' | 'grid'>('list');
  const [sort, setSort] = useState('name');
  const [fileType, setFileType] = useState('all');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [folderStack, setFolderStack] = useState<FolderCrumb[]>([{ name: 'Files' }]);
  const [icloudStack, setIcloudStack] = useState<Array<{ name: string; handle: any }>>([]);
  const [icloudItems, setIcloudItems] = useState<ICloudItem[]>([]);
  const [icloudBusy, setIcloudBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null);
  const [openOfficeId, setOpenOfficeId] = useState<string | null>(null);
  const [openGoogleFile, setOpenGoogleFile] = useState<GoogleEditorSource | null>(null);

  const statusQuery = useQuery({
    queryKey: ['cloud-file-status'],
    queryFn: () => fetchJson<StatusResponse>('/api/files/status'),
    staleTime: 30_000,
  });
  const officeQuery = useQuery({
    queryKey: ['office-files'],
    queryFn: () =>
      fetchJson<{
        enabled: boolean;
        files: Array<{
          documentId: string;
          title: string;
          extension: 'docx' | 'xlsx' | 'pptx';
          updatedAt: number;
        }>;
      }>('/api/office'),
    staleTime: 30_000,
  });
  useEffect(() => {
    if (connectionsOpen) void statusQuery.refetch();
  }, [connectionsOpen, statusQuery.refetch]);
  const libraryQuery = useInfiniteQuery({
    queryKey: ['file-library', deferredSearch],
    initialPageParam: { documents: null, uploads: null } as Record<string, string | null>,
    queryFn: async ({ pageParam, signal }) => {
      const pages = await Promise.all(
        Object.entries(pageParam).map(async ([kind, cursor]) => {
          const params = new URLSearchParams({ kind, search: deferredSearch });
          if (cursor) params.set('cursor', cursor);
          return { kind, ...(await readFilePage(`/api/files/library?${params}`, signal)) };
        }),
      );
      return {
        items: pages.flatMap((page) => page.items),
        cursors: Object.fromEntries(
          pages.filter((page) => page.nextCursor).map((page) => [page.kind, page.nextCursor!]),
        ),
      };
    },
    getNextPageParam: (page) => (Object.keys(page.cursors).length ? page.cursors : undefined),
    staleTime: 15_000,
  });

  useEffect(() => {
    const readOpenFile = () => {
      const params = new URLSearchParams(window.location.search);
      setOpenDocumentId(params.get('document'));
      setOpenOfficeId(params.get('office'));
      const connectionId = params.get('connection');
      const fileId = params.get('file');
      const mimeType = params.get('mime');
      setOpenGoogleFile(
        params.get('provider') === 'google_drive' && connectionId && fileId && isGoogleNativeMime(mimeType)
          ? { connectionId, fileId, mimeType }
          : null,
      );
    };
    readOpenFile();
    const onPopState = () => {
      readOpenFile();
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('lab86-mail:files-navigate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('lab86-mail:files-navigate', onPopState);
    };
  }, []);

  const openDocument = (documentId: string) => {
    setOpenOfficeId(null);
    pushDocumentDeepLink(documentId);
    setOpenGoogleFile(null);
    setOpenDocumentId(documentId);
  };

  const openOfficeDocument = (documentId: string) => {
    const params = new URLSearchParams(window.location.search);
    for (const key of ['document', 'provider', 'connection', 'file', 'mime']) params.delete(key);
    params.set('view', 'files');
    params.set('office', documentId);
    window.history.pushState(null, '', `${window.location.pathname}?${params}`);
    setOpenOfficeId(documentId);
    setOpenDocumentId(null);
    setOpenGoogleFile(null);
  };

  const openGoogleDocument = (source: GoogleEditorSource) => {
    const params = new URLSearchParams(window.location.search);
    params.set('view', 'files');
    params.delete('office');
    setOpenOfficeId(null);
    params.delete('document');
    params.set('provider', 'google_drive');
    params.set('connection', source.connectionId);
    params.set('file', source.fileId);
    params.set('mime', source.mimeType);
    window.history.pushState(null, '', `${window.location.pathname}?${params}`);
    setOpenDocumentId(null);
    setOpenGoogleFile(source);
  };

  const closeDocument = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete('document');
    params.delete('office');
    setOpenOfficeId(null);
    params.delete('provider');
    params.delete('connection');
    params.delete('file');
    params.delete('mime');
    const query = params.toString();
    window.history.pushState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    setOpenDocumentId(null);
    setOpenGoogleFile(null);
    void libraryQuery.refetch();
    void officeQuery.refetch();
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('files_connected');
    const error = params.get('files_error');
    if (connected) toast.success(`${connected} connected`);
    if (error) toast.error(error);
    if (connected || error) {
      params.delete('files_connected');
      params.delete('files_error');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
      void statusQuery.refetch();
    }
  }, [statusQuery.refetch]);

  const connections = statusQuery.data?.connections || [];
  const locations: Location[] = [
    { kind: 'all', id: 'all', label: 'All files' },
    { kind: 'albatross', id: 'albatross', label: 'Albatross' },
    ...connections.map(
      (connection): Location => ({
        kind: 'connection',
        id: connection.connectionId,
        label: connection.accountEmail || connection.displayName || providerLabel(connection.provider),
        connection,
      }),
    ),
    { kind: 'icloud', id: 'icloud', label: 'iCloud Drive' },
  ];
  const location = locations.find((item) => item.id === locationId) || locations[0];
  const currentFolder = folderStack.at(-1);
  const locationRootName =
    location.kind === 'connection' ? providerLabel(location.connection!.provider) : location.label;

  useEffect(() => {
    const pending = pendingFolderRef.current;
    if (pending?.connectionId && pending.connectionId === location.id) {
      setFolderStack([{ name: locationRootName }, { id: pending.id, name: pending.name }]);
      pendingFolderRef.current = null;
    } else {
      setFolderStack([{ name: locationRootName }]);
    }
    setSearch('');
  }, [location.id, locationRootName]);

  const cloudQuery = useInfiniteQuery({
    queryKey: [
      'cloud-files',
      location.kind === 'connection' ? location.id : 'all',
      location.kind === 'connection' ? currentFolder?.id || 'root' : 'root',
      deferredSearch,
      connections.map((connection) => connection.connectionId).join(','),
    ],
    enabled: location.kind === 'connection' || (location.kind === 'all' && connections.length > 0),
    initialPageParam: null as Record<string, string | null> | null,
    queryFn: async ({ pageParam, signal }) => {
      const targets = location.kind === 'connection' ? [location.connection!] : connections;
      const pages = await Promise.all(
        targets
          .filter((connection) => !pageParam || connection.connectionId in pageParam)
          .map(async (connection) => {
            const params = new URLSearchParams({
              connectionId: connection.connectionId,
            });
            if (location.kind === 'connection' && currentFolder?.id) {
              params.set('folderId', currentFolder.id);
            }
            if (deferredSearch) params.set('q', deferredSearch);
            if (pageParam?.[connection.connectionId])
              params.set('cursor', pageParam[connection.connectionId]!);
            try {
              const page = await readFilePage(`/api/files/browse?${params}`, signal);
              return { page, id: connection.connectionId, failure: null };
            } catch (error) {
              if (signal.aborted) throw error;
              if (location.kind === 'connection') throw error;
              return {
                page: { items: [], nextCursor: pageParam?.[connection.connectionId] || null },
                id: connection.connectionId,
                failure: {
                  connection:
                    connection.accountEmail || connection.displayName || providerLabel(connection.provider),
                  message: error instanceof Error ? error.message : 'Drive unavailable',
                },
              };
            }
          }),
      );
      return {
        items: pages.flatMap(({ page }) => page.items),
        failures: pages.flatMap(({ failure }) => (failure ? [failure] : [])),
        cursors: Object.fromEntries(
          pages
            .filter(({ page, failure }) => page.nextCursor || failure)
            .map(({ page, id }) => [id, page.nextCursor || null]),
        ),
      };
    },
    getNextPageParam: (page) => (Object.keys(page.cursors).length ? page.cursors : undefined),
    retry: false,
  });
  const cloudItems = useMemo(() => mergeFilePages(cloudQuery.data?.pages), [cloudQuery.data]);
  const cloudFailures = cloudQuery.data?.pages.at(-1)?.failures || [];
  const localItems = useMemo(
    () => [
      ...mergeFilePages(libraryQuery.data?.pages),
      ...(officeQuery.data?.files || [])
        .filter((file) => file.title.toLowerCase().includes(deferredSearch.toLowerCase()))
        .map(
          (file): DocumentFileItem => ({
            id: `office:${file.documentId}`,
            officeDocumentId: file.documentId,
            name: file.title,
            provider: 'albatross',
            isFolder: false,
            modifiedAt: file.updatedAt,
            mimeType:
              file.extension === 'docx'
                ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                : file.extension === 'xlsx'
                  ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                  : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            webUrl: `/api/office/${file.documentId}/content`,
          }),
        ),
    ],
    [libraryQuery.data, officeQuery.data, deferredSearch],
  );
  const visibleItems = useMemo(() => {
    const deviceItems = icloudItems.filter((item) =>
      item.name.toLowerCase().includes(deferredSearch.toLowerCase()),
    );
    let items: CloudFileItem[];
    if (location.kind === 'albatross') items = localItems;
    else if (location.kind === 'icloud') items = deviceItems;
    else if (location.kind === 'connection') {
      items = cloudItems;
    } else {
      items = [...localItems, ...cloudItems, ...deviceItems];
    }
    const filtered = sortItems(items.filter((item) => fileMatchesType(item, fileType)));
    return sort === 'modified'
      ? filtered.sort(
          (a, b) => Number(b.isFolder) - Number(a.isFolder) || (b.modifiedAt || 0) - (a.modifiedAt || 0),
        )
      : filtered;
  }, [cloudItems, deferredSearch, icloudItems, localItems, location.kind, fileType, sort]);

  const uploadMutation = useMutation({
    mutationFn: async (files: File[]) => {
      const form = new FormData();
      for (const file of files) form.append('files', file);
      return fetchJson('/api/agent/uploads', {
        method: 'POST',
        body: form,
      });
    },
    onSuccess: async () => {
      toast.success('Added to Albatross');
      setLocationId('albatross');
      await queryClient.invalidateQueries({ queryKey: ['albatross-files'] });
      await queryClient.invalidateQueries({
        queryKey: ['file-library'],
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const createDocumentMutation = useMutation({
    mutationFn: (kind: DocumentKind) =>
      fetchJson<{ ok: true; document: AlbatrossDocumentRecord }>('/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      }),
    onSuccess: async ({ document }) => {
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
      await queryClient.invalidateQueries({ queryKey: ['file-library'] });
      setLocationId('albatross');
      openDocument(document.documentId);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const importOfficeMutation = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set('file', file);
      return fetchJson<{ document: { documentId: string } }>('/api/office', { method: 'POST', body: form });
    },
    onSuccess: async ({ document }) => {
      await officeQuery.refetch();
      openOfficeDocument(document.documentId);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // Excel comes in through the spreadsheet engine in the browser (its reader
  // needs a DOM parser); the server stores the untouched bytes alongside the
  // engine snapshot so the original is always downloadable.
  const importXlsxMutation = useMutation({
    mutationFn: async (file: File) => {
      const loaded = await loadSpreadsheetEngine();
      const imported = await importXlsxWorkbook(loaded, file);
      const form = new FormData();
      form.set('file', file);
      form.set('title', file.name.replace(/\.xlsx$/iu, ''));
      form.set('warnings', JSON.stringify(imported.warnings));
      form.set(
        'model',
        JSON.stringify({
          kind: 'sheet',
          version: 2,
          engine: ODOO_SPREADSHEET_ENGINE,
          engineVersion: loaded.engine.__info__.version,
          workbook: imported.workbook,
        }),
      );
      const result = await fetchJson<{ ok: true; document: AlbatrossDocumentRecord }>(
        '/api/documents/import',
        {
          method: 'POST',
          body: form,
        },
      );
      return { document: result.document, warnings: imported.warnings };
    },
    onSuccess: async ({ document, warnings }) => {
      await queryClient.invalidateQueries({ queryKey: ['file-library'] });
      setLocationId('albatross');
      if (warnings.length) {
        toast.warning(`Imported with ${warnings.length} ${warnings.length === 1 ? 'note' : 'notes'}`, {
          description: 'Open the import notes in the editor before relying on affected cells.',
        });
      } else {
        toast.success('Workbook imported');
      }
      openDocument(document.documentId);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const disconnectMutation = useMutation({
    mutationFn: (connectionId: string) =>
      fetchJson('/api/files/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      }),
    onSuccess: async () => {
      toast.success('Drive disconnected');
      setLocationId('all');
      await queryClient.invalidateQueries({
        queryKey: ['cloud-file-status'],
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const loadICloudDirectory = async (handle: any, nextStack: Array<{ name: string; handle: any }>) => {
    setIcloudBusy(true);
    try {
      const items: ICloudItem[] = [];
      for await (const [name, entry] of handle.entries()) {
        if (entry.kind === 'directory') {
          items.push({
            id: `${nextStack.map((item) => item.name).join('/')}/${name}`,
            name,
            provider: 'icloud',
            isFolder: true,
            handle: entry,
          });
        } else {
          const file = await entry.getFile();
          items.push({
            id: `${nextStack.map((item) => item.name).join('/')}/${name}`,
            name,
            provider: 'icloud',
            mimeType: file.type || undefined,
            size: file.size,
            modifiedAt: file.lastModified,
            isFolder: false,
            handle: entry,
          });
        }
      }
      setIcloudStack(nextStack);
      setIcloudItems(sortItems(items) as ICloudItem[]);
      setLocationId('icloud');
      setConnectionsOpen(false);
    } catch (error) {
      if ((error as { name?: string })?.name !== 'AbortError') {
        toast.error('Could not open that iCloud Drive folder.');
      }
    } finally {
      setIcloudBusy(false);
    }
  };

  const chooseICloudFolder = async () => {
    const picker = (window as any).showDirectoryPicker;
    if (typeof picker !== 'function') {
      fallbackFolderInputRef.current?.click();
      return;
    }
    try {
      const handle = await picker({ mode: 'read' });
      await loadICloudDirectory(handle, [{ name: handle.name, handle }]);
    } catch (error) {
      if ((error as { name?: string })?.name !== 'AbortError') {
        toast.error('Could not open that iCloud Drive folder.');
      }
    }
  };

  const onFallbackFolder = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const root =
      (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split('/')[0] ||
      'iCloud Drive';
    setIcloudItems(
      files.map(
        (file): ICloudItem => ({
          id: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
          name: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
          provider: 'icloud',
          mimeType: file.type || undefined,
          size: file.size,
          modifiedAt: file.lastModified,
          isFolder: false,
          localFile: file,
        }),
      ),
    );
    setIcloudStack([{ name: root, handle: null }]);
    setLocationId('icloud');
    setConnectionsOpen(false);
    event.target.value = '';
  };

  const openItem = async (item: CloudFileItem) => {
    if (item.isFolder) {
      if (item.provider === 'icloud' && (item as ICloudItem).handle) {
        const next = [...icloudStack, { name: item.name, handle: (item as ICloudItem).handle }];
        await loadICloudDirectory((item as ICloudItem).handle, next);
      } else if (location.kind === 'connection') {
        setFolderStack((current) => [...current, { id: item.id, name: item.name }]);
      } else if (item.connectionId) {
        pendingFolderRef.current = item;
        setLocationId(item.connectionId);
      }
      return;
    }
    const documentId = (item as DocumentFileItem).documentId;
    const officeDocumentId = (item as DocumentFileItem).officeDocumentId;
    if (officeDocumentId) {
      openOfficeDocument(officeDocumentId);
      return;
    }
    if (documentId) {
      openDocument(documentId);
      return;
    }
    if (item.provider === 'google_drive' && item.connectionId && isGoogleNativeMime(item.mimeType)) {
      openGoogleDocument({
        connectionId: item.connectionId,
        fileId: item.id,
        mimeType: item.mimeType,
        webUrl: item.webUrl,
      });
      return;
    }
    if (item.provider === 'icloud') {
      const local = item as ICloudItem;
      const file = local.localFile || (local.handle ? await local.handle.getFile() : null);
      if (!file) return;
      const url = URL.createObjectURL(file);
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }
    if (item.webUrl) {
      window.open(item.webUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const handleFiles = (files: File[]) => {
    if (!files.length) return;
    if (files.length > 5) {
      toast.warning(`Only the first 5 of ${files.length} files will be uploaded.`);
    }
    uploadMutation.mutate(files.slice(0, 5));
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    handleFiles(Array.from(event.dataTransfer.files));
  };

  const loading =
    ((location.kind === 'all' || location.kind === 'albatross') && libraryQuery.isLoading) ||
    statusQuery.isLoading ||
    cloudQuery.isFetching ||
    icloudBusy;
  const loadError =
    statusQuery.error ||
    ((location.kind === 'all' || location.kind === 'albatross') && libraryQuery.error) ||
    (location.kind === 'connection' ? cloudQuery.error : null);
  const hasMore = Boolean(
    ((location.kind === 'all' || location.kind === 'albatross') && libraryQuery.hasNextPage) ||
      ((location.kind === 'all' || location.kind === 'connection') && cloudQuery.hasNextPage),
  );
  const retryFiles = () => {
    void statusQuery.refetch();
    if (location.kind === 'all' || location.kind === 'albatross') void libraryQuery.refetch();
    if (location.kind === 'connection' || (location.kind === 'all' && connections.length))
      void cloudQuery.refetch();
  };

  // Editors are keyed by file identity: a deep link or history navigation
  // that swaps the open file must never reuse an instance whose drafts and
  // in-flight saves belong to the previous file. The editors retain and flush
  // their outgoing edits on unmount (see useOutgoingEdits).
  if (openOfficeId)
    return <OfficeEditor key={openOfficeId} documentId={openOfficeId} onClose={closeDocument} />;
  if (openDocumentId) {
    return <DocumentEditor key={openDocumentId} documentId={openDocumentId} onClose={closeDocument} />;
  }
  if (openGoogleFile) {
    return (
      <GoogleDocumentEditor
        officeEnabled={officeQuery.data?.enabled === true}
        key={`${openGoogleFile.connectionId}:${openGoogleFile.fileId}:${openGoogleFile.mimeType}`}
        source={openGoogleFile}
        onClose={closeDocument}
      />
    );
  }

  return (
    <section
      aria-label="Files"
      className="@container/files relative flex h-full min-h-0 min-w-0 flex-col bg-[var(--color-content)]"
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <input
        ref={officeInputRef}
        type="file"
        accept=".docx,.xlsx,.pptx"
        className="hidden"
        aria-label="Import Office working copy"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) importOfficeMutation.mutate(file);
        }}
      />
      <input
        ref={xlsxInputRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        aria-label="Import Excel workbook"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) importXlsxMutation.mutate(file);
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          handleFiles(Array.from(event.target.files || []));
          event.target.value = '';
        }}
      />
      <input
        ref={fallbackFolderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onFallbackFolder}
        {...({ webkitdirectory: '' } as any)}
      />

      {/* Two bars. The header names the surface and holds search and the two
          verbs; the toolbar below holds where you are and how the list reads. */}
      <header className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-[var(--color-border)] p-3 @min-[680px]/files:grid-cols-[auto_minmax(160px,1fr)_auto_auto] @min-[680px]/files:px-4">
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold tracking-tight">Files</h1>
          <p className="hidden truncate text-[11.5px] text-[var(--color-text-muted)] @min-[680px]/files:block">
            {deferredSearch
              ? 'Library names, plus drive names and content, account-wide'
              : location.kind === 'all'
                ? 'Your library and every connected drive'
                : `Files in ${location.label}`}
          </p>
        </div>
        <label className="relative col-span-3 row-start-2 block min-w-0 @min-[680px]/files:col-span-1 @min-[680px]/files:col-start-2 @min-[680px]/files:row-start-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-text-faint)]" />
          <input
            aria-label="Search files"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`Search ${location.label}`}
            className="control-field h-8 w-full pl-8 pr-3 text-[12.5px]"
          />
        </label>
        <Button
          type="button"
          aria-label="Manage drives"
          variant="outline"
          size="sm"
          onClick={() => setConnectionsOpen(true)}
        >
          <Cloud className="size-3.5" />
          <span className="hidden @min-[480px]/files:inline">Drives</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" disabled={createDocumentMutation.isPending}>
              {createDocumentMutation.isPending ? (
                <Ring className="size-3.5" />
              ) : (
                <Plus className="size-3.5" />
              )}
              New
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {officeQuery.data?.enabled ? (
              <DropdownMenuItem
                disabled={importOfficeMutation.isPending}
                onSelect={() => officeInputRef.current?.click()}
              >
                <Upload className="size-3.5" /> Import Office working copy
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => createDocumentMutation.mutate('doc')}>
              <FileText className="size-3.5" /> Document
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => createDocumentMutation.mutate('sheet')}>
              <FileSpreadsheet className="size-3.5" /> Spreadsheet
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={importXlsxMutation.isPending}
              onSelect={() => xlsxInputRef.current?.click()}
            >
              <Upload className="size-3.5" /> Import Excel workbook
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => createDocumentMutation.mutate('deck')}>
              <FilePresentation className="size-3.5" /> Presentation
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
              <Upload className="size-3.5" /> Upload files
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
          <FileLocationPicker
            locations={locations.map((item) => ({
              id: item.id,
              label: item.label,
              needsAttention: item.connection?.status === 'error',
            }))}
            value={locationId}
            onChange={(id) => {
              setSearch('');
              if (id === 'icloud' && !icloudStack.length) void chooseICloudFolder();
              else setLocationId(id);
            }}
            onManage={() => setConnectionsOpen(true)}
          />
          {location.kind === 'connection' && folderStack.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Back one folder"
              onClick={() => {
                setSearch('');
                setFolderStack((current) => current.slice(0, -1));
              }}
            >
              <ArrowLeft className="size-3.5" />
            </Button>
          ) : location.kind === 'icloud' && icloudStack.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Back one folder"
              onClick={() => {
                const next = icloudStack.slice(0, -1);
                const parent = next.at(-1);
                if (parent?.handle) {
                  void loadICloudDirectory(parent.handle, next);
                }
              }}
            >
              <ArrowLeft className="size-3.5" />
            </Button>
          ) : null}
          <nav
            className={cn(
              'min-w-0 max-w-full flex-1 items-center overflow-hidden text-[12.5px]',
              (location.kind === 'connection' && folderStack.length > 1) ||
                (location.kind === 'icloud' && icloudStack.length > 1)
                ? 'flex'
                : 'hidden',
            )}
            aria-label="Folder path"
          >
            {(location.kind === 'connection'
              ? folderStack
              : location.kind === 'icloud' && icloudStack.length
                ? icloudStack.map((item) => ({ id: item.name, name: item.name }))
                : [{ id: location.id, name: location.label }]
            ).map((crumb, index, list) => (
              <span key={crumb.id || crumb.name} className="flex min-w-0 items-center">
                {index ? (
                  <ChevronRight className="mx-0.5 size-3 shrink-0 text-[var(--color-text-faint)]" />
                ) : null}
                <button
                  type="button"
                  disabled={index === list.length - 1}
                  onClick={() => {
                    setSearch('');
                    if (location.kind === 'connection')
                      setFolderStack((current) => current.slice(0, index + 1));
                    else if (location.kind === 'icloud') {
                      const next = icloudStack.slice(0, index + 1);
                      if (next.at(-1)?.handle) void loadICloudDirectory(next.at(-1)!.handle, next);
                    }
                  }}
                  className={cn(
                    'truncate',
                    index === list.length - 1
                      ? 'font-medium text-[var(--color-text)]'
                      : 'text-[var(--color-text-muted)]',
                  )}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>
          <span className="ml-1 hidden text-[11px] tabular-nums text-[var(--color-text-faint)] sm:inline">
            {visibleItems.length}
            {hasMore ? '+' : ''} {visibleItems.length === 1 ? 'item' : 'items'}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <select
              aria-label="File type"
              value={fileType}
              onChange={(event) => setFileType(event.target.value)}
              className="control-field h-8 px-2 text-base sm:text-[12px]"
            >
              <option value="all">All types</option>
              <option value="documents">Documents</option>
              <option value="pdf">PDFs</option>
              <option value="images">Images</option>
              <option value="folders">Folders</option>
            </select>
            <select
              aria-label="Sort files"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              className="control-field h-8 px-2 text-base sm:text-[12px]"
            >
              <option value="name">By name</option>
              <option value="modified">Recently modified</option>
            </select>
          </div>
          <div className="flex items-center rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] p-0.5">
            <button
              type="button"
              aria-label="List view"
              aria-pressed={layout === 'list'}
              onClick={() => setLayout('list')}
              className={cn(
                'grid size-9 place-items-center rounded text-[var(--color-text-muted)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] sm:size-7',
                layout === 'list' &&
                  'bg-[var(--color-bg-elevated)] text-[var(--color-text)] shadow-[var(--shadow-control)]',
              )}
            >
              <List className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Grid view"
              aria-pressed={layout === 'grid'}
              onClick={() => setLayout('grid')}
              className={cn(
                'grid size-9 place-items-center rounded text-[var(--color-text-muted)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] sm:size-7',
                layout === 'grid' &&
                  'bg-[var(--color-bg-elevated)] text-[var(--color-text)] shadow-[var(--shadow-control)]',
              )}
            >
              <Grid2X2 className="size-3.5" />
            </button>
          </div>
        </div>

        {location.kind === 'all' && cloudFailures.length ? (
          <div
            role="status"
            className="flex items-start gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-4 py-2 text-xs text-[var(--color-text)]"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <details className="min-w-0 flex-1">
              <summary className="cursor-pointer">
                {cloudFailures.length} {cloudFailures.length === 1 ? 'drive needs' : 'drives need'} attention.
                Your other files are still available.
              </summary>
              <ul className="mt-2 space-y-1 break-words text-[var(--color-text-muted)]">
                {cloudFailures.map((failure) => (
                  <li key={failure.connection}>
                    {failure.connection} — {failure.message}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="mt-2 min-h-9 font-medium underline underline-offset-2"
                onClick={() => setConnectionsOpen(true)}
              >
                Manage connections
              </button>
            </details>
            <button
              type="button"
              className="shrink-0 font-medium underline underline-offset-2"
              onClick={() => void cloudQuery.refetch()}
            >
              Retry
            </button>
          </div>
        ) : null}

        {loadError && visibleItems.length ? (
          <div
            role="status"
            className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-muted)]"
          >
            <span className="min-w-0 flex-1">Some files could not refresh. Showing available files.</span>
            <button type="button" onClick={retryFiles} className="min-h-9 underline underline-offset-2">
              Retry
            </button>
          </div>
        ) : null}

        <div className="relative min-h-0 flex-1 overflow-y-auto">
          {loadError && !visibleItems.length ? (
            <ErrorState message={(loadError as Error).message} onRetry={retryFiles} />
          ) : (loading || search.trim() !== deferredSearch) && !visibleItems.length ? (
            <div className="grid h-full place-items-center">
              <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
                <Ring className="size-4" />
                Loading files…
              </div>
            </div>
          ) : visibleItems.length ? (
            layout === 'list' ? (
              <FileList items={visibleItems} showLocation={location.kind === 'all'} onOpen={openItem} />
            ) : (
              <FileGrid items={visibleItems} onOpen={openItem} />
            )
          ) : (
            <EmptyFiles
              location={location}
              hasConnections={connections.length > 0}
              searching={Boolean(deferredSearch) || fileType !== 'all'}
              hasMore={hasMore}
              onUpload={() => fileInputRef.current?.click()}
              onConnect={() => setConnectionsOpen(true)}
              onChooseICloud={() => void chooseICloudFolder()}
            />
          )}
          {hasMore ? (
            <div className="border-t border-[var(--color-border)] p-4 text-center">
              <p className="mb-2 text-xs text-[var(--color-text-muted)]">
                More sources remain to check. Sorting and type filters apply to loaded files.
              </p>
              <Button
                variant="outline"
                disabled={libraryQuery.isFetching || cloudQuery.isFetching}
                onClick={() => {
                  if ((location.kind === 'all' || location.kind === 'albatross') && libraryQuery.hasNextPage)
                    void libraryQuery.fetchNextPage();
                  if ((location.kind === 'all' || location.kind === 'connection') && cloudQuery.hasNextPage)
                    void cloudQuery.fetchNextPage();
                }}
              >
                {libraryQuery.isFetching || cloudQuery.isFetching ? 'Loading…' : 'Load more files'}
              </Button>
            </div>
          ) : null}
        </div>
      </main>

      {dragging ? (
        <div
          className="pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-accent-soft)]/90 backdrop-blur-sm"
          aria-hidden
        >
          <div className="text-center text-[var(--color-accent)]">
            <Upload className="mx-auto size-6" />
            <div className="mt-2 text-[14px] font-medium">Drop files into Albatross</div>
            <div className="mt-0.5 text-[11.5px] opacity-75">Up to 5 files, 25 MB total</div>
          </div>
        </div>
      ) : null}

      <DriveConnectionsDialog
        open={connectionsOpen}
        onOpenChange={setConnectionsOpen}
        providers={statusQuery.data?.providers || []}
        connections={connections}
        icloudBusy={icloudBusy}
        onChooseICloud={() => void chooseICloudFolder()}
        onDisconnect={(connectionId) => {
          if (window.confirm('Disconnect this drive from Albatross?')) {
            disconnectMutation.mutate(connectionId);
          }
        }}
      />
    </section>
  );
}

function FileList({
  items,
  showLocation,
  onOpen,
}: {
  items: CloudFileItem[];
  showLocation: boolean;
  onOpen: (item: CloudFileItem) => void;
}) {
  return (
    <div className="min-w-0" data-file-list>
      <div
        className={cn(
          'sticky top-0 z-10 hidden h-8 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-content)]/95 px-4 text-[10px] font-medium text-[var(--color-text-faint)] backdrop-blur md:grid',
          showLocation
            ? 'grid-cols-[minmax(0,1fr)_90px_28px] lg:grid-cols-[minmax(0,1fr)_120px_90px_70px_28px]'
            : 'grid-cols-[minmax(0,1fr)_90px_28px] lg:grid-cols-[minmax(0,1fr)_90px_100px_28px]',
        )}
      >
        <span>Name</span>
        {showLocation ? <span className="hidden lg:block">Location</span> : null}
        <span>Modified</span>
        <span className="hidden lg:block">{showLocation ? 'Size' : 'Owner / size'}</span>
        <span />
      </div>
      {items.map((item) => {
        const Icon = fileIcon(item);
        return (
          <div
            key={`${item.provider}:${item.connectionId || ''}:${item.id}`}
            className={cn(
              'group grid min-h-14 w-full grid-cols-[minmax(0,1fr)_44px] items-center gap-3 border-b border-[var(--color-border)]/70 px-4 text-left transition-colors hover:bg-[var(--color-bg-muted)] focus-within:bg-[var(--color-bg-muted)] md:min-h-11',
              showLocation
                ? 'md:grid-cols-[minmax(0,1fr)_90px_28px] lg:grid-cols-[minmax(0,1fr)_120px_90px_70px_28px]'
                : 'md:grid-cols-[minmax(0,1fr)_90px_28px] lg:grid-cols-[minmax(0,1fr)_90px_100px_28px]',
            )}
          >
            <button
              type="button"
              title={item.name}
              onClick={() => void onOpen(item)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                void onOpen(item);
              }}
              className="flex min-h-11 min-w-0 items-center gap-2.5 rounded text-left focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
            >
              <span
                className={cn(
                  'grid size-7 shrink-0 place-items-center rounded-md',
                  item.isFolder
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : 'bg-[var(--color-bg-subtle)] text-[var(--color-text-muted)]',
                )}
              >
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium">{item.name}</span>
                <span className="block truncate text-[11px] text-[var(--color-text-muted)] md:hidden">
                  {providerLabel(item.provider)} · {formatDate(item.modifiedAt)}
                </span>
              </span>
            </button>
            {showLocation ? (
              <span className="hidden min-w-0 items-center gap-1.5 truncate text-[11.5px] text-[var(--color-text-muted)] lg:flex">
                <ProviderMark provider={item.provider} className="size-3.5" />
                <span className="truncate">{providerLabel(item.provider)}</span>
              </span>
            ) : null}
            <span className="hidden text-[11.5px] text-[var(--color-text-muted)] md:block">
              {formatDate(item.modifiedAt)}
            </span>
            <span className="hidden truncate text-[11.5px] text-[var(--color-text-muted)] lg:block">
              {showLocation
                ? item.isFolder
                  ? '—'
                  : formatBytes(item.size)
                : item.owner || (item.isFolder ? '—' : formatBytes(item.size))}
            </span>
            <FileActions item={item} onOpen={onOpen} />
          </div>
        );
      })}
    </div>
  );
}

function FileGrid({ items, onOpen }: { items: CloudFileItem[]; onOpen: (item: CloudFileItem) => void }) {
  const [failedThumbnails, setFailedThumbnails] = useState<Set<string>>(new Set());
  return (
    <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
      {items.map((item) => {
        const Icon = fileIcon(item);
        return (
          <button
            type="button"
            title={item.name}
            key={`${item.provider}:${item.connectionId || ''}:${item.id}`}
            onClick={() => void onOpen(item)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              void onOpen(item);
            }}
            className="group min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-2.5 text-left transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-muted)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            <span className="relative grid aspect-[1.45] place-items-center overflow-hidden rounded-lg bg-[var(--color-bg-subtle)]">
              {item.thumbnailUrl && !failedThumbnails.has(item.thumbnailUrl) ? (
                // biome-ignore lint/performance/noImgElement: provider thumbnail URLs are remote and short-lived.
                <img
                  src={item.thumbnailUrl}
                  alt=""
                  className="size-full object-cover"
                  referrerPolicy="no-referrer"
                  onError={() => setFailedThumbnails((current) => new Set(current).add(item.thumbnailUrl!))}
                />
              ) : (
                <Icon
                  className={cn(
                    'size-8',
                    item.isFolder
                      ? 'fill-[var(--color-accent-soft)] text-[var(--color-accent)]'
                      : 'text-[var(--color-text-faint)]',
                  )}
                />
              )}
              <span className="absolute right-2 top-2 grid size-5 place-items-center rounded-md bg-[var(--color-bg)]/85 shadow-sm backdrop-blur">
                <ProviderMark provider={item.provider} className="size-3" />
              </span>
            </span>
            <span className="mt-2 block truncate text-[12px] font-medium">{item.name}</span>
            <span className="mt-0.5 flex items-center justify-between gap-2 text-[10.5px] text-[var(--color-text-faint)]">
              <span>{formatDate(item.modifiedAt)}</span>
              <span>{item.isFolder ? 'Folder' : formatBytes(item.size)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FileActions({ item, onOpen }: { item: CloudFileItem; onOpen: (item: CloudFileItem) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${item.name}`}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className="grid size-11 place-items-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-control)] hover:text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] md:size-7"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void onOpen(item)}>
          {item.isFolder ? (
            <FolderOpen className="size-3.5" />
          ) : item.provider === 'albatross' ? (
            <Download className="size-3.5" />
          ) : (
            <File className="size-3.5" />
          )}
          {item.isFolder ? 'Open folder' : 'Open'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyFiles({
  location,
  hasConnections,
  searching,
  hasMore,
  onUpload,
  onConnect,
  onChooseICloud,
}: {
  location: Location;
  hasConnections: boolean;
  searching: boolean;
  hasMore: boolean;
  onUpload: () => void;
  onConnect: () => void;
  onChooseICloud: () => void;
}) {
  if (searching || hasMore) {
    return (
      <div className={cn('grid min-h-48 place-items-center px-6 py-10 text-center', !hasMore && 'h-full')}>
        <div>
          <Search className="mx-auto size-6 text-[var(--color-text-faint)]" />
          <h2 className="mt-3 text-[13.5px] font-medium">
            {hasMore ? 'No matches in the files checked so far' : 'No files found'}
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
            {hasMore
              ? 'Load more to keep looking through this location.'
              : 'Try a shorter name, another type, or a different location.'}
          </p>
        </div>
      </div>
    );
  }
  if (location.kind === 'icloud') {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="max-w-sm">
          <AppleLogo className="mx-auto size-7" />
          <h2 className="mt-3 text-[14px] font-medium">Choose your iCloud Drive folder</h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            Albatross reads the folder only in this browser. Nothing is copied to the server until you
            explicitly add a file.
          </p>
          <Button className="mt-4" size="sm" onClick={onChooseICloud}>
            <FolderOpen className="size-3.5" />
            Choose folder
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center px-6 py-10 text-center">
      <div className="max-w-md">
        <div className="mx-auto grid size-12 place-items-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-accent)] shadow-[var(--shadow-soft)]">
          <FolderOpen className="size-5" />
        </div>
        <h2 className="mt-4 text-[15px] font-semibold tracking-tight">
          {location.kind === 'albatross'
            ? 'Add your first file'
            : hasConnections
              ? 'This folder is empty'
              : 'Connect your files'}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
          {location.kind === 'albatross'
            ? 'Upload documents, images, and project material you want close to your work.'
            : hasConnections
              ? 'Add a file here or switch to another connected location.'
              : 'Browse files where they already live. Connect Google Drive or OneDrive, or open iCloud Drive on this device.'}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button size="sm" onClick={onUpload}>
            <Upload className="size-3.5" />
            Upload to Albatross
          </Button>
          {location.kind !== 'albatross' ? (
            <Button variant="outline" size="sm" onClick={onConnect}>
              <Cloud className="size-3.5" />
              Connect a drive
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div className="max-w-sm">
        <Cloud className="mx-auto size-6 text-[var(--color-danger)]" />
        <h2 className="mt-3 text-[13.5px] font-medium">Files could not refresh</h2>
        <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">{message}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

function DriveConnectionsDialog({
  open,
  onOpenChange,
  providers,
  connections,
  icloudBusy,
  onChooseICloud,
  onDisconnect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: ProviderStatus[];
  connections: Connection[];
  icloudBusy: boolean;
  onChooseICloud: () => void;
  onDisconnect: (connectionId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-[var(--color-border)] px-5 py-4">
          <DialogTitle className="text-[15px]">File locations</DialogTitle>
          <DialogDescription className="text-[11.5px]">
            Browse connected drives. Edit supported documents or open the original for full fidelity.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 p-3">
          {providers.map((provider) => {
            const connected = connections.filter((item) => item.provider === provider.id);
            return (
              <ProviderConnectionRow
                key={provider.id}
                provider={provider}
                connections={connected}
                onDisconnect={onDisconnect}
              />
            );
          })}
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3">
            <div className="flex items-start gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-control)]">
                <AppleLogo className="size-4.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium">iCloud Drive</div>
                <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  Choose a synced iCloud folder from Finder or File Explorer. Access stays on this device.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={icloudBusy}
                onClick={onChooseICloud}
              >
                {icloudBusy ? <Ring className="size-3.5" /> : <FolderOpen className="size-3.5" />}
                Choose
              </Button>
            </div>
          </div>
        </div>
        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-5 py-3 text-[10.5px] leading-relaxed text-[var(--color-text-faint)]">
          Google Drive and OneDrive remain the source of truth. Supported Google office files edit inline
          without creating an Albatross copy; uploads are stored in Albatross only when you choose them.
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProviderConnectionRow({
  provider,
  connections,
  onDisconnect,
}: {
  provider: ProviderStatus;
  connections: Connection[];
  onDisconnect: (connectionId: string) => void;
}) {
  const icon =
    provider.id === 'google_drive' ? (
      <GoogleLogo className="size-4.5" />
    ) : (
      <MicrosoftLogo className="size-4.5" />
    );
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-control)]">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-medium">{provider.label}</span>
            {connections.length ? (
              <span className="rounded-ui bg-emerald-500/10 px-1.5 py-0.5 text-[9.5px] font-medium text-emerald-700 dark:text-emerald-300">
                Connected
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            Browse files and edit supported documents with provider-authorized access.
          </p>
          {connections.map((connection) => (
            <div
              key={connection.connectionId}
              className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--color-bg-subtle)] px-2.5 py-2"
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  connection.status === 'error' ? 'bg-[var(--color-danger)]' : 'bg-emerald-500',
                )}
              />
              <span className="min-w-0 flex-1 truncate text-[11px]">
                {connection.accountEmail || connection.displayName || provider.label}
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => onDisconnect(connection.connectionId)}
                className="text-[var(--color-text-faint)] hover:text-[var(--color-danger)]"
              >
                Disconnect
              </Button>
            </div>
          ))}
        </div>
        <Button
          asChild={provider.configured}
          type="button"
          variant="outline"
          size="sm"
          disabled={!provider.configured}
          title={
            provider.configured ? `Connect ${provider.label}` : `${provider.label} OAuth is not configured`
          }
        >
          {provider.configured ? (
            <a
              href={`/api/files/oauth/start?provider=${provider.id}&redirectTo=${encodeURIComponent('/?view=files')}`}
            >
              <Plus className="size-3.5" />
              {connections.some((connection) => connection.status === 'error')
                ? 'Reconnect'
                : connections.length
                  ? 'Add'
                  : 'Connect'}
            </a>
          ) : (
            <>
              <Settings2 className="size-3.5" />
              Setup needed
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

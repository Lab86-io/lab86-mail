'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
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
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { DocumentEditor } from '@/components/files/DocumentEditor';
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

interface AlbatrossUpload {
  id: string;
  name: string;
  mimeType?: string;
  size: number;
  createdAt: number;
  url?: string | null;
}

interface BrowseResponse {
  ok: boolean;
  items: CloudFileItem[];
  nextCursor?: string;
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

function documentAsFileItem(document: AlbatrossDocumentRecord): DocumentFileItem {
  return {
    id: document.documentId,
    documentId: document.documentId,
    documentKind: document.kind,
    name: document.title,
    provider: 'albatross',
    mimeType:
      document.kind === 'doc'
        ? 'application/x-albatross-document'
        : document.kind === 'sheet'
          ? 'application/x-albatross-spreadsheet'
          : 'application/x-albatross-presentation',
    modifiedAt: document.updatedAt,
    owner: document.google ? 'Albatross · Google Drive' : 'Albatross',
    webUrl: document.google?.webUrl,
    isFolder: false,
  };
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
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
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

function uploadAsFileItem(upload: AlbatrossUpload): CloudFileItem {
  return {
    id: upload.id,
    name: upload.name,
    provider: 'albatross',
    mimeType: upload.mimeType,
    size: upload.size,
    modifiedAt: upload.createdAt,
    webUrl: upload.url || undefined,
    isFolder: false,
  };
}

export function FilesSurface() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fallbackFolderInputRef = useRef<HTMLInputElement>(null);
  const pendingFolderRef = useRef<CloudFileItem | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [locationId, setLocationId] = useState('all');
  const [layout, setLayout] = useState<'list' | 'grid'>('list');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [folderStack, setFolderStack] = useState<FolderCrumb[]>([{ name: 'Files' }]);
  const [icloudStack, setIcloudStack] = useState<Array<{ name: string; handle: any }>>([]);
  const [icloudItems, setIcloudItems] = useState<ICloudItem[]>([]);
  const [icloudBusy, setIcloudBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ['cloud-file-status'],
    queryFn: () => fetchJson<StatusResponse>('/api/files/status'),
    staleTime: 30_000,
  });
  const uploadsQuery = useQuery({
    queryKey: ['albatross-files'],
    queryFn: () => fetchJson<{ ok: true; files: AlbatrossUpload[] }>('/api/agent/uploads'),
    staleTime: 15_000,
  });
  const documentsQuery = useQuery({
    queryKey: ['documents'],
    queryFn: () => fetchJson<{ ok: true; documents: AlbatrossDocumentRecord[] }>('/api/documents?limit=500'),
    staleTime: 10_000,
  });

  useEffect(() => {
    setOpenDocumentId(new URLSearchParams(window.location.search).get('document'));
    const onPopState = () => {
      setOpenDocumentId(new URLSearchParams(window.location.search).get('document'));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const openDocument = (documentId: string) => {
    pushDocumentDeepLink(documentId);
    setOpenDocumentId(documentId);
  };

  const closeDocument = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete('document');
    const query = params.toString();
    window.history.pushState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    setOpenDocumentId(null);
    void documentsQuery.refetch();
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

  const cloudQuery = useQuery({
    queryKey: [
      'cloud-files',
      location.kind === 'connection' ? location.id : 'all',
      location.kind === 'connection' ? currentFolder?.id || 'root' : 'root',
      deferredSearch,
      connections.map((connection) => connection.connectionId).join(','),
    ],
    enabled: location.kind === 'connection' || (location.kind === 'all' && connections.length > 0),
    queryFn: async () => {
      const targets = location.kind === 'connection' ? [location.connection!] : connections;
      const pages = await Promise.all(
        targets.map(async (connection) => {
          const params = new URLSearchParams({
            connectionId: connection.connectionId,
          });
          if (location.kind === 'connection' && currentFolder?.id) {
            params.set('folderId', currentFolder.id);
          }
          if (deferredSearch) params.set('q', deferredSearch);
          try {
            return await fetchJson<BrowseResponse>(`/api/files/browse?${params}`);
          } catch (error) {
            if (location.kind === 'connection') throw error;
            return { ok: false, items: [] } as BrowseResponse;
          }
        }),
      );
      return pages.flatMap((page) => page.items);
    },
  });

  const uploadItems = useMemo(
    () => (uploadsQuery.data?.files || []).map(uploadAsFileItem),
    [uploadsQuery.data],
  );
  const documentItems = useMemo(
    () => (documentsQuery.data?.documents || []).map(documentAsFileItem),
    [documentsQuery.data],
  );
  const localItems = useMemo(() => [...documentItems, ...uploadItems], [documentItems, uploadItems]);
  const visibleItems = useMemo(() => {
    let items: CloudFileItem[];
    if (location.kind === 'albatross') items = localItems;
    else if (location.kind === 'icloud') items = icloudItems;
    else if (location.kind === 'connection') {
      items = cloudQuery.data || [];
    } else {
      items = [...localItems, ...(cloudQuery.data || []), ...icloudItems];
    }
    if (deferredSearch && location.kind !== 'connection') {
      const needle = deferredSearch.toLowerCase();
      items = items.filter((item) => item.name.toLowerCase().includes(needle));
    }
    return sortItems(items);
  }, [cloudQuery.data, deferredSearch, icloudItems, localItems, location.kind]);

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
      await queryClient.invalidateQueries({
        queryKey: ['albatross-files'],
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
      setLocationId('albatross');
      openDocument(document.documentId);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const importGoogleMutation = useMutation({
    mutationFn: (item: CloudFileItem) =>
      fetchJson<{ ok: true; document: AlbatrossDocumentRecord }>('/api/files/google/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: item.connectionId,
          fileId: item.id,
          mimeType: item.mimeType,
          webUrl: item.webUrl,
        }),
      }),
    onSuccess: async ({ document }) => {
      toast.success('Opened in the Albatross editor');
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
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
    if (documentId) {
      openDocument(documentId);
      return;
    }
    if (
      item.provider === 'google_drive' &&
      item.connectionId &&
      [
        'application/vnd.google-apps.document',
        'application/vnd.google-apps.spreadsheet',
        'application/vnd.google-apps.presentation',
      ].includes(item.mimeType || '')
    ) {
      importGoogleMutation.mutate(item);
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
    uploadsQuery.isLoading ||
    documentsQuery.isLoading ||
    statusQuery.isLoading ||
    cloudQuery.isFetching ||
    icloudBusy ||
    importGoogleMutation.isPending;
  const loadError =
    statusQuery.error ||
    uploadsQuery.error ||
    documentsQuery.error ||
    (location.kind === 'connection' ? cloudQuery.error : null);

  if (openDocumentId) {
    return <DocumentEditor documentId={openDocumentId} onClose={closeDocument} />;
  }

  return (
    <section
      aria-label="Files"
      className="relative flex h-full min-h-0 flex-col bg-[var(--color-bg)]"
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

      <header className="flex min-h-14 items-center gap-3 border-b border-[var(--color-border)] px-4">
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold tracking-tight">Files</h1>
          <p className="hidden text-[11px] text-[var(--color-text-faint)] sm:block">
            One place for the work behind your work
          </p>
        </div>
        <label className="relative ml-auto hidden w-full max-w-md sm:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-text-faint)]" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`Search ${location.label}`}
            className="h-8 w-full rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] pl-8 pr-3 text-[12.5px] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
          />
        </label>
        <Button type="button" variant="outline" size="sm" onClick={() => setConnectionsOpen(true)}>
          <Cloud className="size-3.5" />
          <span className="hidden sm:inline">Drives</span>
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
            <DropdownMenuItem onSelect={() => createDocumentMutation.mutate('doc')}>
              <FileText className="size-3.5" /> Document
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => createDocumentMutation.mutate('sheet')}>
              <FileSpreadsheet className="size-3.5" /> Spreadsheet
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

      <div className="border-b border-[var(--color-border)] px-3 py-2 sm:hidden">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-text-faint)]" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`Search ${location.label}`}
            className="h-8 w-full rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] pl-8 pr-3 text-[12.5px] outline-none"
          />
        </label>
      </div>

      <div className="flex min-h-0 flex-1 flex-col sm:grid sm:grid-cols-[210px_minmax(0,1fr)]">
        <nav className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)]/55 p-2 sm:min-h-0 sm:overflow-y-auto sm:border-b-0 sm:border-r">
          <div className="flex gap-1 overflow-x-auto sm:block sm:space-y-0.5">
            <LocationButton
              active={locationId === 'all'}
              icon={<FolderOpen className="size-4" />}
              label="All files"
              onClick={() => setLocationId('all')}
            />
            <LocationButton
              active={locationId === 'albatross'}
              icon={<HardDrive className="size-4" />}
              label="Albatross"
              count={localItems.length}
              onClick={() => setLocationId('albatross')}
            />
          </div>
          <div className="mt-3 hidden sm:block">
            <div className="mb-1 flex items-center justify-between px-2">
              <span className="text-[10px] font-medium uppercase tracking-[0.09em] text-[var(--color-text-faint)]">
                Locations
              </span>
              <button
                type="button"
                aria-label="Manage drives"
                className="rounded p-0.5 text-[var(--color-text-faint)] hover:bg-[var(--color-control)] hover:text-[var(--color-text)]"
                onClick={() => setConnectionsOpen(true)}
              >
                <Settings2 className="size-3.5" />
              </button>
            </div>
            <div className="space-y-0.5">
              {connections.map((connection) => (
                <LocationButton
                  key={connection.connectionId}
                  active={locationId === connection.connectionId}
                  icon={<ProviderMark provider={connection.provider} className="size-4" />}
                  label={
                    connection.accountEmail || connection.displayName || providerLabel(connection.provider)
                  }
                  alert={connection.status === 'error'}
                  onClick={() => setLocationId(connection.connectionId)}
                />
              ))}
              <LocationButton
                active={locationId === 'icloud'}
                icon={<AppleLogo className="size-4" />}
                label={icloudStack.length ? icloudStack[0].name : 'iCloud Drive'}
                onClick={() => {
                  if (icloudStack.length) setLocationId('icloud');
                  else void chooseICloudFolder();
                }}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setConnectionsOpen(true)}
            className="mt-4 hidden w-full items-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] px-2.5 py-2 text-left text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-control)] hover:text-[var(--color-text)] sm:flex"
          >
            <Plus className="size-3.5" />
            Add a drive
          </button>
        </nav>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-12 items-center gap-2 border-b border-[var(--color-border)] px-3 sm:px-4">
            {location.kind === 'connection' && folderStack.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Back one folder"
                onClick={() => setFolderStack((current) => current.slice(0, -1))}
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
            <div className="flex min-w-0 items-center text-[12.5px]">
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
                  <span
                    className={cn(
                      'truncate',
                      index === list.length - 1
                        ? 'font-medium text-[var(--color-text)]'
                        : 'text-[var(--color-text-muted)]',
                    )}
                  >
                    {crumb.name}
                  </span>
                </span>
              ))}
            </div>
            <span className="ml-1 hidden text-[11px] tabular-nums text-[var(--color-text-faint)] sm:inline">
              {visibleItems.length} {visibleItems.length === 1 ? 'item' : 'items'}
            </span>
            <div className="ml-auto flex items-center rounded-md border border-[var(--color-control-border)] bg-[var(--color-control)] p-0.5">
              <button
                type="button"
                aria-label="List view"
                aria-pressed={layout === 'list'}
                onClick={() => setLayout('list')}
                className={cn(
                  'grid size-6 place-items-center rounded text-[var(--color-text-muted)]',
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
                  'grid size-6 place-items-center rounded text-[var(--color-text-muted)]',
                  layout === 'grid' &&
                    'bg-[var(--color-bg-elevated)] text-[var(--color-text)] shadow-[var(--shadow-control)]',
                )}
              >
                <Grid2X2 className="size-3.5" />
              </button>
            </div>
          </div>

          <div className="relative min-h-0 flex-1 overflow-y-auto">
            {loadError ? (
              <ErrorState
                message={(loadError as Error).message}
                onRetry={() => {
                  void statusQuery.refetch();
                  void uploadsQuery.refetch();
                  void documentsQuery.refetch();
                  void cloudQuery.refetch();
                }}
              />
            ) : loading && !visibleItems.length ? (
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
                searching={Boolean(deferredSearch)}
                onUpload={() => fileInputRef.current?.click()}
                onConnect={() => setConnectionsOpen(true)}
                onChooseICloud={() => void chooseICloudFolder()}
              />
            )}
          </div>
        </main>
      </div>

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

function LocationButton({
  active,
  icon,
  label,
  count,
  alert,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  count?: number;
  alert?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-[12px] transition-colors sm:w-full',
        active
          ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-control)] hover:text-[var(--color-text)]',
      )}
    >
      {icon}
      <span className="max-w-36 truncate">{label}</span>
      {alert ? (
        <span
          className="ml-auto size-1.5 rounded-full bg-[var(--color-danger)]"
          title="Connection needs attention"
        />
      ) : count ? (
        <span className="ml-auto text-[10px] tabular-nums text-[var(--color-text-faint)]">{count}</span>
      ) : null}
    </button>
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
    <div className="min-w-[560px]">
      <div
        className={cn(
          'sticky top-0 z-10 grid h-8 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 px-4 text-[10px] font-medium uppercase tracking-[0.07em] text-[var(--color-text-faint)] backdrop-blur',
          showLocation
            ? 'grid-cols-[minmax(240px,1fr)_150px_110px_76px_28px]'
            : 'grid-cols-[minmax(240px,1fr)_140px_110px_28px]',
        )}
      >
        <span>Name</span>
        {showLocation ? <span>Location</span> : null}
        <span>Modified</span>
        <span>{showLocation ? 'Size' : 'Owner'}</span>
        <span />
      </div>
      {items.map((item) => {
        const Icon = fileIcon(item);
        return (
          <div
            key={`${item.provider}:${item.connectionId || ''}:${item.id}`}
            className={cn(
              'group grid min-h-11 w-full items-center gap-3 border-b border-[var(--color-border)]/70 px-4 text-left transition-colors hover:bg-[var(--color-bg-muted)]',
              showLocation
                ? 'grid-cols-[minmax(240px,1fr)_150px_110px_76px_28px]'
                : 'grid-cols-[minmax(240px,1fr)_140px_110px_28px]',
            )}
          >
            <button
              type="button"
              onDoubleClick={() => void onOpen(item)}
              onClick={() => {
                if (item.isFolder) void onOpen(item);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                void onOpen(item);
              }}
              className="flex min-w-0 items-center gap-2.5 text-left"
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
                <span className="block truncate text-[10.5px] text-[var(--color-text-faint)] sm:hidden">
                  {providerLabel(item.provider)}
                </span>
              </span>
            </button>
            {showLocation ? (
              <span className="flex min-w-0 items-center gap-1.5 truncate text-[11.5px] text-[var(--color-text-muted)]">
                <ProviderMark provider={item.provider} className="size-3.5" />
                <span className="truncate">{providerLabel(item.provider)}</span>
              </span>
            ) : null}
            <span className="text-[11.5px] text-[var(--color-text-muted)]">
              {formatDate(item.modifiedAt)}
            </span>
            <span className="truncate text-[11.5px] text-[var(--color-text-muted)]">
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
  return (
    <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
      {items.map((item) => {
        const Icon = fileIcon(item);
        return (
          <button
            type="button"
            key={`${item.provider}:${item.connectionId || ''}:${item.id}`}
            onDoubleClick={() => void onOpen(item)}
            onClick={() => {
              if (item.isFolder) void onOpen(item);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              void onOpen(item);
            }}
            className="group min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-2.5 text-left shadow-[var(--shadow-soft)] transition-[border-color,transform,background-color] hover:-translate-y-0.5 hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-muted)]"
          >
            <span className="relative grid aspect-[1.45] place-items-center overflow-hidden rounded-lg bg-[var(--color-bg-subtle)]">
              {item.thumbnailUrl ? (
                // biome-ignore lint/performance/noImgElement: provider thumbnail URLs are remote and short-lived.
                <img
                  src={item.thumbnailUrl}
                  alt=""
                  className="size-full object-cover"
                  referrerPolicy="no-referrer"
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
          className="grid size-7 place-items-center rounded-md text-[var(--color-text-faint)] opacity-100 transition-opacity hover:bg-[var(--color-control)] hover:text-[var(--color-text)] focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
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
  onUpload,
  onConnect,
  onChooseICloud,
}: {
  location: Location;
  hasConnections: boolean;
  searching: boolean;
  onUpload: () => void;
  onConnect: () => void;
  onChooseICloud: () => void;
}) {
  if (searching) {
    return (
      <div className="grid h-full place-items-center px-6 text-center">
        <div>
          <Search className="mx-auto size-6 text-[var(--color-text-faint)]" />
          <h2 className="mt-3 text-[13.5px] font-medium">No files found</h2>
          <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
            Try a shorter name or search a different location.
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
              : 'Bring your files into Albatross'}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
          {location.kind === 'albatross'
            ? 'Upload documents, images, and project material you want close to your work.'
            : hasConnections
              ? 'Add a file here or switch to another connected location.'
              : 'Connect Google Drive or OneDrive, choose iCloud Drive on this device, or upload directly.'}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button size="sm" onClick={onUpload}>
            <Upload className="size-3.5" />
            Add files
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
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-[var(--color-border)] px-5 py-4">
          <DialogTitle className="text-[15px]">File locations</DialogTitle>
          <DialogDescription className="text-[11.5px]">
            Browse connected drives and edit Google Docs, Sheets, and Slides inline.
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
          Google Drive and OneDrive are writable connections. Albatross edits supported office files inline
          and syncs Albatross documents back to Google.
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
              <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9.5px] font-medium text-emerald-700 dark:text-emerald-300">
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
              className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--color-bg-subtle)] px-2.5 py-2"
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
              {connections.length ? 'Add' : 'Connect'}
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

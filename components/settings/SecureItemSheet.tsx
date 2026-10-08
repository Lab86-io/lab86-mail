'use client';

// The one add surface for Passwords and IDs (docs/albatross-secure-store.md,
// V1 to V3, V9, V12, V13): a right-side sheet that Settings, the chat card,
// the composer notice, and the sign-in handoff all open. The site comes
// first because it sets where the value may go. Secret fields are masked
// inputs; the value goes to the server once and never comes back.
// `SecureItemForm` is the body on its own, for the harness and the tests.

import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  checkSecureValues,
  expiryWarning,
  ID_TYPE_OPTIONS,
  refusalLine,
  sitePreview,
} from '@/lib/albatross/secure-view';
import type { IdNumberType, SecureItemCreate, SecureItemKind, SecureItemView } from '@/lib/secure/contract';
import { cn } from '@/lib/utils';
import { MANAGER_IGNORE_ATTRIBUTES, MaskedInput } from './MaskedInput';

export const SHEET_COPY = {
  title: {
    sign_in: 'Add a sign-in',
    id_number: 'Add an ID',
    date_of_birth: 'Add your date of birth',
    api_key: 'Add a key',
  } as Record<SecureItemKind, string>,
  blurb: {
    sign_in: 'Albatross signs in with it on this site only. The password never appears again after you save.',
    id_number:
      'Albatross asks you the first time a site needs it. The number never appears again after you save.',
    date_of_birth: 'Albatross can tell a form your age. It types the date only on sites you allow.',
    api_key: 'Albatross calls this host with it. The key never appears again after you save.',
  } as Record<SecureItemKind, string>,
  site: 'Site',
  host: 'Host',
  label: 'Label',
  labelHelp: 'How it appears in your list.',
  type: 'Type',
  region: 'State or province',
  regionHelp: 'Two letters are enough: NY.',
  country: 'Country',
  countryHelp: 'A two-letter code: US.',
  number: 'Number',
  expires: 'Expiry date',
  nameOnId: 'Name on the ID',
  date: 'Date of birth',
  dateHelp: 'Any past date.',
  username: 'Username or email',
  password: 'Password',
  key: 'Key',
  header: 'Header',
  headerHelp:
    'Leave empty to send the key as Authorization: Bearer. Type a header name, such as x-api-key, for another scheme.',
  maskedHelp: 'Hidden as you type. After you save, you can replace it but not see it.',
  askFirst: 'Albatross asks you the first time a site needs this ID.',
  fromDetails: 'From your details',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  fine: 'Encrypted on the server. Never shown in a conversation.',
  dateOfBirthExists: 'Your date of birth is saved. Replace it there.',
  /** The site came from the chat (ask_secure_detail): a page could have put it there. */
  siteSuggested: {
    sign_in: 'Albatross suggested this site. Check that it is the site where you sign in.',
    api_key: 'Albatross suggested this site. Check that it is the API address of the service.',
  } as Partial<Record<SecureItemKind, string>>,
  failed: 'Could not save this.',
} as const;

export interface SecureSheetRequest {
  kind: SecureItemKind;
  /** The site or host to start with (a request card, a handoff, the notice). */
  site?: string | null;
  /**
   * The site came from the model's ask_secure_detail input, not from the user
   * or the page a run opened: the form says so until the user edits it.
   */
  siteSuggested?: boolean;
  label?: string | null;
  /** Secret values to start with (the composer notice). They stay in this form only. */
  values?: Record<string, string>;
}

export interface SecureItemFormProps {
  request: SecureSheetRequest;
  onSave: (body: SecureItemCreate) => Promise<SecureItemView>;
  onSaved?: (item: SecureItemView) => void;
  onCancel: () => void;
  /** The saved name, for "Name on the ID". */
  defaultNameOnId?: string | null;
  /** A date of birth is saved already: the form refuses a second one before the server does. */
  hasDateOfBirth?: boolean;
  /** Keep the fields and the footer in one column without the sheet frame. */
  className?: string;
}

const inputClass = 'h-8 text-[12.5px]';

function fieldId(base: string, name: string) {
  return `${base}-${name}`;
}

export function SecureItemForm({
  request,
  onSave,
  onSaved,
  onCancel,
  defaultNameOnId,
  hasDateOfBirth,
  className,
}: SecureItemFormProps) {
  const base = useId();
  const { kind } = request;
  const [site, setSite] = useState(request.site ?? '');
  const [siteSuggested, setSiteSuggested] = useState(Boolean(request.siteSuggested && request.site));
  const [label, setLabel] = useState(request.label ?? '');
  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...(kind === 'id_number' ? { type: 'drivers_license', country: 'US' } : {}),
    ...(kind === 'id_number' && defaultNameOnId ? { name_on_id: defaultNameOnId } : {}),
    ...(request.values ?? {}),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const preview = useMemo(
    () => (kind === 'sign_in' || kind === 'api_key' ? sitePreview(site, kind) : null),
    [site, kind],
  );
  const expiryNote = kind === 'id_number' ? expiryWarning(values.expires) : null;
  const idType = (values.type as IdNumberType | undefined) ?? 'drivers_license';

  // One date of birth for each user (lead decision 4): the form says so before the server does.
  const dateOfBirthExists = kind === 'date_of_birth' && Boolean(hasDateOfBirth);

  const set = (field: string, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setFormError(null);
  };

  const submit = async () => {
    if (busy) return;
    const checked = checkSecureValues(kind, values, { label, site });
    if (Object.keys(checked).length) {
      setErrors(checked);
      const first = Object.keys(checked)[0];
      document.getElementById(fieldId(base, first))?.focus();
      return;
    }
    if (dateOfBirthExists) return;
    const body: SecureItemCreate = { kind, values: {} };
    const trimmedLabel = label.trim();
    if (trimmedLabel) body.label = trimmedLabel;
    if (kind === 'sign_in' || kind === 'api_key') body.sites = [site.trim()];
    for (const [field, value] of Object.entries(values)) {
      if (typeof value === 'string' && value.trim()) body.values[field] = value.trim();
    }
    setBusy(true);
    setFormError(null);
    try {
      const item = await onSave(body);
      // The typed values leave memory with this form.
      setValues({});
      onSaved?.(item);
    } catch (cause) {
      const error = cause as Error & { code?: string; field?: string; reason?: string };
      const message = error.message || SHEET_COPY.failed;
      if (error.code === 'refused' || error.code === 'invalid' || error.code === 'site') {
        const field = error.field || (error.code === 'site' ? 'site' : secretFieldOf(kind));
        setErrors((current) => ({ ...current, [field]: refusalLine(error.reason, message) }));
        document.getElementById(fieldId(base, field))?.focus();
      } else setFormError(message);
    } finally {
      setBusy(false);
    }
  };

  const errorLine = (field: string) =>
    errors[field] ? (
      <p
        id={`${fieldId(base, field)}-error`}
        role="alert"
        className="text-[11.5px] text-[var(--color-danger)]"
      >
        {errors[field]}
      </p>
    ) : null;
  const help = (text: string) => (
    <p className="text-[11.5px] leading-snug text-[var(--color-text-faint)]">{text}</p>
  );
  const invalid = (field: string) =>
    errors[field]
      ? { 'aria-invalid': true as const, 'aria-describedby': `${fieldId(base, field)}-error` }
      : {};

  return (
    <form
      data-slot="secure-item-form"
      data-kind={kind}
      className={cn('flex min-h-0 flex-1 flex-col', className)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
        {kind === 'sign_in' || kind === 'api_key' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId(base, 'site')} className="text-[12.5px]">
              {kind === 'api_key' ? SHEET_COPY.host : SHEET_COPY.site}
            </Label>
            <Input
              id={fieldId(base, 'site')}
              value={site}
              inputMode="url"
              autoComplete="off"
              placeholder={kind === 'api_key' ? 'api.openai.com' : 'chase.com'}
              disabled={busy}
              onChange={(event) => {
                setSite(event.target.value);
                setSiteSuggested(false);
                setErrors((current) => {
                  if (!current.site) return current;
                  const next = { ...current };
                  delete next.site;
                  return next;
                });
              }}
              className={inputClass}
              {...MANAGER_IGNORE_ATTRIBUTES}
              {...invalid('site')}
            />
            {errorLine('site') ??
              (siteSuggested && SHEET_COPY.siteSuggested[kind] ? (
                <p
                  data-slot="site-suggested"
                  className="text-[11.5px] leading-snug text-[var(--color-warning)]"
                >
                  {SHEET_COPY.siteSuggested[kind]}
                </p>
              ) : preview ? (
                <p
                  data-slot="site-preview"
                  className={cn(
                    'text-[11.5px] leading-snug',
                    preview.ok ? 'text-[var(--color-text-faint)]' : 'text-[var(--color-danger)]',
                  )}
                >
                  {preview.line}
                </p>
              ) : null)}
          </div>
        ) : null}

        {kind === 'id_number' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId(base, 'type')} className="text-[12.5px]">
              {SHEET_COPY.type}
            </Label>
            <Select value={idType} disabled={busy} onValueChange={(next) => set('type', next)}>
              <SelectTrigger id={fieldId(base, 'type')} className="h-8 w-full text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ID_TYPE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="text-[12.5px]">
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {kind === 'sign_in' || kind === 'api_key' || (kind === 'id_number' && idType === 'other') ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId(base, 'label')} className="text-[12.5px]">
              {SHEET_COPY.label}
            </Label>
            <Input
              id={fieldId(base, 'label')}
              value={label}
              autoComplete="off"
              placeholder={kind === 'api_key' ? 'OpenAI' : kind === 'sign_in' ? 'Chase' : 'Library card'}
              disabled={busy}
              onChange={(event) => {
                setLabel(event.target.value);
                setErrors((current) => {
                  if (!current.label) return current;
                  const next = { ...current };
                  delete next.label;
                  return next;
                });
              }}
              className={inputClass}
              {...invalid('label')}
            />
            {errorLine('label') ?? help(SHEET_COPY.labelHelp)}
          </div>
        ) : null}

        {kind === 'id_number' && (idType === 'drivers_license' || idType === 'state_id') ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId(base, 'region')} className="text-[12.5px]">
              {SHEET_COPY.region}
            </Label>
            <Input
              id={fieldId(base, 'region')}
              value={values.region ?? ''}
              autoComplete="off"
              placeholder="NY"
              disabled={busy}
              onChange={(event) => set('region', event.target.value)}
              className={cn(inputClass, 'max-w-[200px]')}
            />
            {help(SHEET_COPY.regionHelp)}
          </div>
        ) : null}

        {kind === 'id_number' && idType === 'passport' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId(base, 'country')} className="text-[12.5px]">
              {SHEET_COPY.country}
            </Label>
            <Input
              id={fieldId(base, 'country')}
              value={values.country ?? ''}
              autoComplete="off"
              maxLength={2}
              placeholder="US"
              disabled={busy}
              onChange={(event) => set('country', event.target.value.toUpperCase())}
              className={cn(inputClass, 'max-w-[120px] uppercase')}
              {...invalid('country')}
            />
            {errorLine('country') ?? help(SHEET_COPY.countryHelp)}
          </div>
        ) : null}

        {kind === 'sign_in' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId(base, 'username')} className="text-[12.5px]">
              {SHEET_COPY.username}
            </Label>
            <Input
              id={fieldId(base, 'username')}
              value={values.username ?? ''}
              autoComplete="off"
              placeholder="sam.rivera@example.com"
              disabled={busy}
              onChange={(event) => set('username', event.target.value)}
              className={inputClass}
              {...MANAGER_IGNORE_ATTRIBUTES}
              {...invalid('username')}
            />
            {errorLine('username')}
          </div>
        ) : null}

        {kind === 'sign_in' || kind === 'id_number' || kind === 'api_key' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId(base, secretFieldOf(kind))} className="text-[12.5px]">
              {kind === 'sign_in'
                ? SHEET_COPY.password
                : kind === 'id_number'
                  ? SHEET_COPY.number
                  : SHEET_COPY.key}
            </Label>
            <MaskedInput
              id={fieldId(base, secretFieldOf(kind))}
              value={values[secretFieldOf(kind)] ?? ''}
              disabled={busy}
              inputMode={kind === 'id_number' && idType === 'ssn' ? 'numeric' : 'text'}
              invalid={Boolean(errors[secretFieldOf(kind)])}
              describedBy={
                errors[secretFieldOf(kind)] ? `${fieldId(base, secretFieldOf(kind))}-error` : undefined
              }
              onChange={(next) => set(secretFieldOf(kind), next)}
            />
            {errorLine(secretFieldOf(kind)) ?? help(SHEET_COPY.maskedHelp)}
          </div>
        ) : null}

        {kind === 'id_number' && idType !== 'ssn' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId(base, 'expires')} className="text-[12.5px]">
              {SHEET_COPY.expires}
            </Label>
            <Input
              id={fieldId(base, 'expires')}
              type="date"
              value={values.expires ?? ''}
              disabled={busy}
              onChange={(event) => set('expires', event.target.value)}
              className={cn(inputClass, 'max-w-[200px]')}
              {...invalid('expires')}
            />
            {errorLine('expires') ??
              (expiryNote ? (
                <p className="text-[11.5px] leading-snug text-[var(--color-warning)]">{expiryNote}</p>
              ) : null)}
          </div>
        ) : null}

        {kind === 'id_number' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId(base, 'name_on_id')} className="text-[12.5px]">
              {SHEET_COPY.nameOnId}
            </Label>
            <Input
              id={fieldId(base, 'name_on_id')}
              value={values.name_on_id ?? ''}
              autoComplete="off"
              placeholder="Sam Rivera"
              disabled={busy}
              onChange={(event) => set('name_on_id', event.target.value)}
              className={inputClass}
              {...MANAGER_IGNORE_ATTRIBUTES}
            />
            {defaultNameOnId && values.name_on_id === defaultNameOnId ? help(SHEET_COPY.fromDetails) : null}
            {help(SHEET_COPY.askFirst)}
          </div>
        ) : null}

        {kind === 'date_of_birth' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId(base, 'date')} className="text-[12.5px]">
              {SHEET_COPY.date}
            </Label>
            <Input
              id={fieldId(base, 'date')}
              type="date"
              value={values.date ?? ''}
              disabled={busy}
              onChange={(event) => set('date', event.target.value)}
              className={cn(inputClass, 'max-w-[200px]')}
              {...invalid('date')}
            />
            {errorLine('date') ?? help(SHEET_COPY.dateHelp)}
          </div>
        ) : null}

        {kind === 'api_key' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId(base, 'header')} className="text-[12.5px]">
              {SHEET_COPY.header}
            </Label>
            <Input
              id={fieldId(base, 'header')}
              value={values.header ?? ''}
              autoComplete="off"
              placeholder="Authorization: Bearer"
              disabled={busy}
              onChange={(event) => set('header', event.target.value)}
              className={inputClass}
            />
            {help(SHEET_COPY.headerHelp)}
          </div>
        ) : null}

        {formError || dateOfBirthExists ? (
          <p role="alert" className="text-[12px] text-[var(--color-danger)]">
            {formError ?? SHEET_COPY.dateOfBirthExists}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--color-border)] px-6 py-3.5">
        <Button type="submit" size="sm" disabled={busy || dateOfBirthExists}>
          {busy ? SHEET_COPY.saving : SHEET_COPY.save}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {SHEET_COPY.cancel}
        </Button>
        <span className="ml-auto max-w-[200px] text-right text-[11px] leading-snug text-[var(--color-text-faint)]">
          {SHEET_COPY.fine}
        </span>
      </div>
    </form>
  );
}

/** The one masked field of a kind. */
export function secretFieldOf(kind: SecureItemKind): string {
  switch (kind) {
    case 'sign_in':
      return 'password';
    case 'id_number':
      return 'number';
    case 'date_of_birth':
      return 'date';
    case 'api_key':
      return 'key';
  }
}

export interface SecureItemSheetProps
  extends Omit<SecureItemFormProps, 'request' | 'onCancel' | 'className'> {
  /** Null keeps the sheet closed. */
  request: SecureSheetRequest | null;
  onClose: () => void;
}

export function SecureItemSheet({ request, onClose, onSaved, ...form }: SecureItemSheetProps) {
  return (
    <Sheet open={Boolean(request)} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-[440px]">
        {request ? (
          <>
            <SheetHeader className="border-b border-[var(--color-border)] px-6 pt-5 pb-4">
              <SheetTitle className="text-[15px] font-semibold">{SHEET_COPY.title[request.kind]}</SheetTitle>
              <SheetDescription className="text-[12px] leading-relaxed text-[var(--color-text-muted)]">
                {SHEET_COPY.blurb[request.kind]}
              </SheetDescription>
            </SheetHeader>
            <SecureItemForm
              // A new request starts from empty fields.
              key={`${request.kind}:${request.site ?? ''}:${request.label ?? ''}`}
              request={request}
              onCancel={onClose}
              onSaved={(item) => {
                onSaved?.(item);
                onClose();
              }}
              {...form}
            />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

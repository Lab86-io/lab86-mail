import Ajv from 'ajv';
import { z } from 'zod';
import catalog from './spreadsheet-command-catalog.json';

export const spreadsheetCommandNames = Object.keys(catalog.commands) as [string, ...string[]];
export const spreadsheetCommandSchema = z
  .object({
    type: z.enum(spreadsheetCommandNames),
    payload: z
      .record(z.string(), z.json())
      .describe(
        'Exact Odoo command payload from spreadsheet_capabilities. Coordinates and zones are zero-based; use stable sheet IDs.',
      ),
    selection: z
      .object({
        sheetId: z.string().min(1),
        zone: z
          .object({
            top: z.number().int().min(0),
            bottom: z.number().int().min(0),
            left: z.number().int().min(0),
            right: z.number().int().min(0),
          })
          .strict(),
      })
      .strict()
      .optional()
      .describe(
        'Select this range before commands such as TRIM_WHITESPACE, REMOVE_DUPLICATES, clipboard, or autofill.',
      ),
  })
  .strict();
export type SpreadsheetCommand = z.infer<typeof spreadsheetCommandSchema>;

const ajv = new Ajv({ strict: false, allErrors: false });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

export function validateSpreadsheetCommand(input: unknown): SpreadsheetCommand {
  const command = spreadsheetCommandSchema.parse(input);
  let validate = validators.get(command.type);
  if (!validate) {
    const entry = catalog.commands[command.type as keyof typeof catalog.commands];
    validate = ajv.compile({ ...entry.schema, $defs: catalog.$defs });
    validators.set(command.type, validate);
  }
  if ('type' in command.payload) throw new Error('Put the command type outside its payload.');
  if (!validate({ ...command.payload, type: command.type })) {
    throw new Error(
      `${command.type}: ${ajv.errorsText(validate.errors)}. Read spreadsheet_capabilities for the exact payload.`,
    );
  }
  return command;
}

/** Include only referenced definitions so a command lookup stays small. */
export function spreadsheetCapabilities(names: string[] = []) {
  const selected: Record<string, unknown> = {};
  const definitions: Record<string, unknown> = {};
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const ref = (value as { $ref?: string }).$ref;
    if (ref) {
      const key = ref.split('/').at(-1)!;
      if (!(key in definitions)) {
        definitions[key] = catalog.$defs[key as keyof typeof catalog.$defs];
        visit(definitions[key]);
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const name of names) {
    const entry = catalog.commands[name as keyof typeof catalog.commands];
    if (!entry) throw new Error(`Unknown spreadsheet command: ${name}`);
    selected[name] = entry;
    visit(entry);
  }
  return {
    engineVersion: catalog.version,
    commands: spreadsheetCommandNames,
    functions: catalog.functions,
    usage:
      'Use document_edit with op spreadsheet_command, command {type, payload}, and the revision from document_get. All Odoo workbook core commands are supported. Read command schemas before writing. Sheet/figure/pivot IDs come from the workbook; new objects need unique IDs. Cell and zone coordinates start at zero. New CREATE_CHART figures require col, row, offset:{x:0,y:0}, and preferably size:{width:480,height:300}. Use optional selection:{sheetId,zone} for selection-based commands. Chart ranges use A1 notation; chart titles are objects such as {text:"Revenue"}. For charts use CREATE_CHART, not text bars. Formulas use the functions available in the installed Odoo engine (REPT is not supported).',
    schemas: selected,
    $defs: definitions,
  };
}

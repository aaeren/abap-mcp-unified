import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import { session_types } from 'abap-adt-api';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';

export class RunHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'abap_unlock',
        description:
          'Release the ABAP enqueue lock (SM12) for an object. Use when abap_set_source or ' +
          'abap_edit_method fails because a previous MCP operation crashed before unlocking. ' +
          'Calls the appropriate DEQUEUE FM. Only affects locks held by the current SAP user. ' +
          'LIMITATION: clears the enqueue lock (SM12) only — NOT the ICM HTTP session lock. ' +
          'If the object is still blocked after this, a stale ICM session holds the ADT lock: ' +
          'kill it in SM04 (delete work process entries for this user showing the ADT class path). ' +
          'Supported types: CLAS, INTF, PROG, FUGR.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name, e.g. /DSN/BP_R_MOD or ZCL_MY_CLASS' },
            type: { type: 'string', description: 'Object type: CLAS, INTF, PROG, or FUGR' }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'abap_run',
        description:
          'Create a temporary ABAP class in $TMP, run it via IF_OO_ADT_CLASSRUN, capture output, then delete it. ' +
          'This is the standard pattern for querying live SAP data or executing one-off ABAP logic. ' +
          'Provide only the body of the run method — the class wrapper is generated automatically. ' +
          'Use out->write() to produce output. ' +
          'IMPORTANT: Declare variables with DATA before SELECT. ' +
          'Use "SELECT * FROM table INTO TABLE lt WHERE ..." (old-style, no inline @DATA) — ' +
          'inline declarations with UP TO N ROWS do not work inside this method. ' +
          'To limit rows, use "DELETE lt FROM N." after the SELECT. ' +
          'If the class name already exists from a previous failed run, pass a different className.',
        inputSchema: {
          type: 'object',
          properties: {
            methodBody: {
              type: 'string',
              description: 'ABAP code to execute. Use out->write() for output. Also accepted as "code".'
            },
            className: {
              type: 'string',
              description: 'Optional class name for the temp class (default: ZCL_TMP_ADT_RUN). Must start with Z. Will be deleted after run. Change this if you get "already exists" errors from a prior failed run.'
            },
            interfaceMethod: {
              type: 'string',
              description: 'Override the detected interface method: "run" (S/4HANA ≤2023) or "main" (S/4HANA 2024+). Auto-detected from the system by default — only set this if auto-detection fails.'
            },
            keepClass: {
              type: 'boolean',
              description: 'If true, skip deletion of the temp class after run. Useful for debugging — lets you inspect the generated source via abap_get_source. Default: false.'
            }
          },
          required: ['methodBody']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_unlock': return this.handleUnlock(args);
      case 'abap_run':    return this.handleRun(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  private async handleUnlock(args: any): Promise<any> {
    const name = (args.name || '').toUpperCase();
    const baseType = (args.type || '').toUpperCase().split('/')[0];

    // Per-type ABAP CALL FUNCTION templates.
    // _scope='2' = all sessions of current user — covers stale locks from dead MCP sessions.
    // CLAS/INTF: FM is DEQUEUE_ESEOCLASS (named after the transaction, not the lock object).
    //   Lock object in SM12 shows as SEOCLSENQ, but the FM is DEQUEUE_ESEOCLASS with
    //   MODE_SEOCLSENQ, CLSNAME, INCTYPE (include type, blank = wildcard), CPDNAME params.
    // PROG/FUGR: FM names are best-guess — correct if they fail.
    const DEQUEUE_ABAP: Record<string, (n: string) => string> = {
      'CLAS': (n) =>
        `CALL FUNCTION 'DEQUEUE_ESEOCLASS'\n` +
        `  EXPORTING\n` +
        `    mode_seoclsenq = 'E'\n` +
        `    clsname        = '${n}'\n` +
        `    inctype        = ' '\n` +
        `    cpdname        = ' '\n` +
        `    _scope         = '2'\n` +
        `    _synchron      = 'X'.`,
      'INTF': (n) =>
        `CALL FUNCTION 'DEQUEUE_ESEOCLASS'\n` +
        `  EXPORTING\n` +
        `    mode_seoclsenq = 'E'\n` +
        `    clsname        = '${n}'\n` +
        `    inctype        = ' '\n` +
        `    cpdname        = ' '\n` +
        `    _scope         = '2'\n` +
        `    _synchron      = 'X'.`,
      'PROG': (n) =>
        `CALL FUNCTION 'DEQUEUE_EENREPSRC'\n` +
        `  EXPORTING\n` +
        `    progname  = '${n}'\n` +
        `    _scope    = '2'\n` +
        `    _synchron = 'X'.`,
      'FUGR': (n) =>
        `CALL FUNCTION 'DEQUEUE_EENLOGOPG'\n` +
        `  EXPORTING\n` +
        `    area      = '${n}'\n` +
        `    _scope    = '2'\n` +
        `    _synchron = 'X'.`,
    };

    const template = DEQUEUE_ABAP[baseType];
    if (!template) {
      this.fail(
        `abap_unlock: unsupported type '${baseType}'. ` +
        `Supported: CLAS, INTF, PROG, FUGR. For other types, use SM12 in SAP GUI.`
      );
    }

    const methodBody =
      `TRY.\n` +
      `  ${template!(name).split('\n').join('\n  ')}\n` +
      `  out->write( |abap_unlock: DEQUEUE FM called for '${name}'. Enqueue lock (SM12) cleared. If object still blocked, a stale ICM session in SM04 holds the ADT lock.| ).\n` +
      `CATCH cx_root INTO DATA(lx).\n` +
      `  out->write( |abap_unlock failed: { lx->get_text( ) }| ).\n` +
      `ENDTRY.`;

    return this.handleRun({ methodBody, className: 'ZCL_TMP_UNLOCK' });
  }

  private buildClassSource(className: string, methodBody: string, methodName: string): string {
    const body = methodBody || '';
    const indented = body.split('\n').map(line => `    ${line}`).join('\n');
    return `CLASS ${className} DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS ${className} IMPLEMENTATION.

  METHOD if_oo_adt_classrun~${methodName}.
${indented}
  ENDMETHOD.

ENDCLASS.`;
  }

  private async handleRun(args: any): Promise<any> {
    // Accept 'code' as an alias for 'methodBody'
    if (args.code && !args.methodBody) args.methodBody = args.code;
    if (!args.methodBody) {
      this.fail('abap_run: methodBody is required — provide the ABAP code to run as the methodBody parameter.');
    }

    const className = (args.className || 'ZCL_TMP_ADT_RUN').toUpperCase();
    const classUrl = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`;
    const sourceUrl = `${classUrl}/source/main`;

    let methodName: string = 'run';
    let classCreated = false;
    let lockHandle: string | null = null;

    try {
      // Ensure stateful session — must be established before auto-detecting the interface method,
      // otherwise getObjectSource may fail silently and fall back to 'run' (wrong on 2024+ systems).
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.login();

      // Auto-detect the correct interface method for this system by reading IF_OO_ADT_CLASSRUN.
      // Older systems (≤2023) use ~run; newer systems (2024+) use ~main.
      // Explicit interfaceMethod param overrides detection.
      if (args.interfaceMethod) {
        methodName = args.interfaceMethod.toLowerCase();
      } else {
        try {
          const ifSource = await this.adtclient.getObjectSource(
            '/sap/bc/adt/oo/interfaces/if_oo_adt_classrun/source/main'
          ) as string;
          methodName = ifSource.toLowerCase().includes('main') ? 'main' : 'run';
        } catch (_) {
          methodName = 'run'; // safe default if interface source unreadable
        }
      }

      // Create temp class in $TMP — if it already exists (leftover from failed run), offer to clean up
      try {
        await this.adtclient.createObject(
          'CLAS/OC',
          className,
          '$TMP',
          'Temporary ADT runner class',
          '/sap/bc/adt/packages/%24tmp',
          undefined,
          undefined
        );
      } catch (createErr: any) {
        const msg = (createErr?.message || '').toLowerCase();
        if (msg.includes('already exists') || msg.includes('exists already')) {
          const deleteIt = await this.confirmWithUser(
            `Class ${className} already exists (leftover from a previous failed run). Delete it and retry?`,
            { className }
          );
          if (deleteIt) {
            try {
              const delLock = await this.adtclient.lock(classUrl);
              await this.adtclient.deleteObject(classUrl, delLock.LOCK_HANDLE);
            } catch (_) {}
            // Retry creation
            await this.adtclient.createObject(
              'CLAS/OC', className, '$TMP', 'Temporary ADT runner class',
              '/sap/bc/adt/packages/%24tmp', undefined, undefined
            );
          } else {
            this.fail(`abap_run: ${className} already exists. Pass a different className (e.g. className="ZCL_TMP_RUN2").`);
          }
        } else {
          throw createErr;
        }
      }
      classCreated = true;

      // Lock → write source → unlock
      const lockResult = await this.adtclient.lock(classUrl);
      lockHandle = lockResult.LOCK_HANDLE;

      const source = this.buildClassSource(className, args.methodBody, methodName);
      await this.adtclient.setObjectSource(sourceUrl, source, lockHandle);

      await this.adtclient.unLock(classUrl, lockHandle);
      lockHandle = null;

      // Activate — if it fails because the method name is wrong for this release, surface a clear hint
      const activationResult = await this.adtclient.activate(className, classUrl);
      // Surface the raw activation result so callers can diagnose unexpected shapes (e.g. release differences)
      const activationSucceeded = activationResult?.success === true;
      if (!activationSucceeded) {
        const messages = (activationResult?.messages || [])
          .map((m: any) => m.shortText || m.objDescr)
          .filter(Boolean)
          .join('; ');
        const lower = messages.toLowerCase();
        const isWrongMethod = lower.includes('main') || lower.includes('run');
        const isPipeError = lower.includes('unmasked') || lower.includes('string template');
        const altMethod = methodName === 'run' ? 'main' : 'run';
        let hint = '';
        if (isPipeError) {
          hint = ' Pipe characters (|) are ABAP string template delimiters. Escape literal pipes with \\| or use CONCATENATE instead.';
        } else if (isWrongMethod) {
          hint = ` Try passing interfaceMethod="${altMethod}" — this system may use if_oo_adt_classrun~${altMethod}.`;
        }
        throw new Error(
          `Activation failed: ${messages || 'no error messages returned'}${hint} ` +
          `[raw activationResult: ${JSON.stringify(activationResult)}]`
        );
      }

      // End the stateful session before classrun — on some systems (e.g. D25/759), activation is only
      // fully committed once the session closes. classrun on an in-session activation sees "not implemented".
      await this.adtclient.logout();
      // Re-login stateless to get a fresh CSRF token for the classrun POST.
      this.adtclient.stateful = session_types.stateless;
      await this.adtclient.login();

      // Call classrun via the underlying HTTP client directly so we can set Accept: text/plain.
      // The library's runClass() sends no Accept header, which causes silent failures on some releases.
      const h = (this.adtclient as any).h;
      let output: any;
      try {
        const response = await h.request(
          `/sap/bc/adt/oo/classrun/${className.toUpperCase()}`,
          { method: 'POST', headers: { Accept: 'text/plain' } }
        );
        output = response.body ?? response.data ?? '';
      } catch (runError: any) {
        const msg = runError?.message || '';
        const status = runError?.response?.status;
        // Extract SAP error body if present — distinguishes "service inactive" (403/404) from runtime errors
        const body = runError?.response?.data || runError?.response?.body || '';
        const bodyStr = typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400);
        if (status === 500 || msg.includes('500')) {
          const detail = bodyStr ? ` SAP response: ${bodyStr}` : '';
          throw new Error(
            `classrun endpoint returned 500. Possible causes: ` +
            `(1) IF_OO_ADT_CLASSRUN is not available on this system release, ` +
            `(2) the ABAP code has a runtime error — check abap_get_dump for a ST22 entry.${detail}`
          );
        }
        const detail = bodyStr ? ` SAP response: ${bodyStr}` : '';
        throw new Error(`classrun failed: ${msg}${detail}`);
      }

      // SAP sometimes returns HTTP 200 with an error string in the body (e.g. "Error: Class does not implement ~main").
      // Detect this and surface it as a real error rather than silently returning garbage output.
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output ?? '');
      if (outputStr.startsWith('Error:') || outputStr.startsWith('Exception:')) {
        const altMethod = methodName === 'run' ? 'main' : 'run';
        const isMethodError = outputStr.toLowerCase().includes('does not implement') ||
          outputStr.toLowerCase().includes(`~${methodName}`);
        const hint = isMethodError
          ? ` Try passing interfaceMethod="${altMethod}" — this system may use if_oo_adt_classrun~${altMethod}.`
          : '';
        throw new Error(`classrun returned error in body (HTTP 200): ${outputStr}${hint}`);
      }

      return this.success({ output, className });

    } catch (error: any) {
      if (lockHandle) {
        try { await this.adtclient.unLock(classUrl, lockHandle); } catch (_) {}
      }
      this.fail(formatError('abap_run', error));
    } finally {
      // Delete the temp class unless keepClass=true was requested.
      // Re-login first — the session may be in a bad state after an error.
      if (classCreated && !args.keepClass) {
        try {
          this.adtclient.stateful = session_types.stateful;
          await this.adtclient.login();
          const deleteLock = await this.adtclient.lock(classUrl);
          await this.adtclient.deleteObject(classUrl, deleteLock.LOCK_HANDLE);
        } catch (_) {
          // Best-effort — if cleanup fails, the class stays in $TMP.
          // Inspect it with abap_get_source(name=className, type=CLAS) or pass a different className on retry.
        }
      }
    }
  }
}

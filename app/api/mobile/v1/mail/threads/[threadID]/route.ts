import { type CurrentUser, requireCurrentUser } from '@/lib/auth/current-user';
import { MobileInputError, mobileErrorResponse, mobileJSON, mobileRequestID } from '@/lib/mobile/v1/http';
import { mailThreadDetailFromTool } from '@/lib/mobile/v1/mail-reads';
import { getTool } from '@/lib/tools';
import { invokeTool } from '@/lib/tools/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface MobileMailThreadDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  readThread(args: { account: string; threadId: string }, user: CurrentUser): Promise<any>;
}

const defaultDependencies: MobileMailThreadDependencies = {
  requireCurrentUser,
  async readThread(args, user) {
    const tool = getTool('get_thread');
    if (!tool) throw new Error('The get_thread domain tool is not registered.');
    return invokeTool(tool, args, {
      agent: 'user',
      account: args.account,
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
    });
  },
};

export function createMobileMailThreadGet(deps: MobileMailThreadDependencies = defaultDependencies) {
  return async function mobileMailThreadGet(
    request: Request,
    context: { params: Promise<{ threadID: string }> },
  ) {
    const requestID = mobileRequestID(request);
    try {
      const user = await deps.requireCurrentUser();
      const { threadID } = await context.params;
      const url = new URL(request.url);
      const accountID = url.searchParams.get('accountID')?.trim();
      if (!accountID) throw new MobileInputError('accountID is required.');
      const thread = await deps.readThread({ account: accountID, threadId: threadID }, user);
      return mobileJSON(mailThreadDetailFromTool(thread, accountID, threadID), undefined, requestID);
    } catch (error) {
      return mobileErrorResponse(error, requestID);
    }
  };
}

export const GET = createMobileMailThreadGet();

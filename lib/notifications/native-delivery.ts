import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { APNsDeliveryError, sendAPNsPush } from './apns';
import type { NotificationEnvelope } from './delivery';
import { nativePushDisabledReason } from './mobile-preferences';

interface NativeDeliveryContext {
  notification: {
    _id: string;
    userId: string;
    title: string;
    body: string;
    deepLink: string;
    type: string;
  };
  mobileDevices: Array<{
    token: string;
    environment: 'development' | 'production';
  }>;
  deliveries: Array<{ channel: string; status: string }>;
  nativeDeviceDeliveries?: Array<{
    token: string;
    status: 'delivered' | 'expired' | 'failed';
  }>;
  preference?: {
    nativePushEnabled?: boolean;
    newMailPushEnabled?: boolean;
    eventSuggestionPushEnabled?: boolean;
  } | null;
}

interface NativeDeliveryDependencies {
  query: typeof convexQuery;
  mutate: typeof convexMutation;
  send: typeof sendAPNsPush;
}

const defaultDependencies: NativeDeliveryDependencies = {
  query: convexQuery,
  mutate: convexMutation,
  send: sendAPNsPush,
};

export async function dispatchNativeNotification(
  userId: string,
  notificationId: string,
  dependencies: NativeDeliveryDependencies = defaultDependencies,
) {
  const context = await dependencies.query<NativeDeliveryContext | null>(
    (api as any).albatrossNotifications.nativeDeliveryContext,
    { userId, notificationId },
  );
  if (!context?.notification) return { sent: 0, failed: 0, skipped: 'not_found' as const };
  const disabled = nativePushDisabledReason(context.notification.type, context.preference);
  if (disabled) return { sent: 0, failed: 0, skipped: disabled };
  if (
    context.deliveries.some((delivery) => delivery.channel === 'native_push' && delivery.status === 'sent')
  ) {
    return { sent: 0, failed: 0, skipped: 'already_sent' as const };
  }
  if (!context.mobileDevices.length) return { sent: 0, failed: 0, skipped: 'no_devices' as const };
  const settledTokens = new Set(
    (context.nativeDeviceDeliveries || [])
      .filter((delivery) => delivery.status === 'delivered' || delivery.status === 'expired')
      .map((delivery) => delivery.token),
  );
  const pendingDevices = context.mobileDevices.filter((device) => !settledTokens.has(device.token));
  if (!pendingDevices.length) {
    const delivered = (context.nativeDeviceDeliveries || []).some(
      (delivery) => delivery.status === 'delivered',
    );
    await dependencies.mutate((api as any).albatrossNotifications.recordDelivery, {
      userId,
      notificationId,
      channel: 'native_push',
      status: delivered ? 'sent' : 'failed',
      error: delivered ? undefined : 'All registered devices are expired.',
    });
    return { sent: 0, failed: delivered ? 0 : settledTokens.size };
  }

  const envelope: NotificationEnvelope = {
    id: String(context.notification._id),
    userId,
    title: context.notification.title,
    body: context.notification.body,
    deepLink: context.notification.deepLink,
  };
  let sent = 0;
  let failed = 0;
  const providerIds: string[] = [];
  const deliveryErrors: string[] = [];
  const unresolvedErrors: string[] = [];
  const recordDevice = async (
    token: string,
    status: 'delivered' | 'expired' | 'failed',
    providerId?: string,
    error?: string,
  ) => {
    try {
      await dependencies.mutate((api as any).albatrossNotifications.recordNativeDeviceDelivery, {
        userId,
        notificationId,
        token,
        status,
        providerId,
        error,
      });
      return true;
    } catch (error) {
      const message = `Could not persist ${status} device receipt: ${
        error instanceof Error ? error.message : String(error)
      }`;
      deliveryErrors.push(message);
      unresolvedErrors.push(message);
      return false;
    }
  };
  for (const device of pendingDevices) {
    try {
      const result = await dependencies.send(envelope, device);
      if (result.providerId) providerIds.push(result.providerId);
      if (await recordDevice(device.token, 'delivered', result.providerId)) sent += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      deliveryErrors.push(message);
      if (error instanceof APNsDeliveryError && error.invalidToken) {
        await recordDevice(device.token, 'expired', undefined, message);
      } else {
        unresolvedErrors.push(message);
        await recordDevice(device.token, 'failed', undefined, message);
      }
    }
  }
  const status = sent > 0 && unresolvedErrors.length === 0 ? 'sent' : 'failed';
  await dependencies.mutate((api as any).albatrossNotifications.recordDelivery, {
    userId,
    notificationId,
    channel: 'native_push',
    status,
    providerId: providerIds.join(',').slice(0, 500) || undefined,
    error: status === 'sent' ? undefined : deliveryErrors.join('; ').slice(0, 500),
  });
  return { sent, failed };
}

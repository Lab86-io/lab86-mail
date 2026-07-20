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

  const envelope: NotificationEnvelope = {
    id: String(context.notification._id),
    userId,
    title: context.notification.title,
    body: context.notification.body,
    deepLink: context.notification.deepLink,
  };
  let sent = 0;
  const providerIds: string[] = [];
  const errors: string[] = [];
  for (const device of context.mobileDevices) {
    try {
      const result = await dependencies.send(envelope, device);
      sent += 1;
      if (result.providerId) providerIds.push(result.providerId);
      await dependencies.mutate((api as any).albatrossNotifications.updateMobileDeviceDelivery, {
        token: device.token,
        status: 'delivered',
      });
    } catch (error) {
      if (error instanceof APNsDeliveryError && error.invalidToken) {
        await dependencies.mutate((api as any).albatrossNotifications.updateMobileDeviceDelivery, {
          token: device.token,
          status: 'expired',
        });
      }
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  await dependencies.mutate((api as any).albatrossNotifications.recordDelivery, {
    userId,
    notificationId,
    channel: 'native_push',
    status: sent > 0 ? 'sent' : 'failed',
    providerId: providerIds.join(',').slice(0, 500) || undefined,
    error: sent > 0 ? undefined : errors.join('; ').slice(0, 500),
  });
  return { sent, failed: errors.length };
}

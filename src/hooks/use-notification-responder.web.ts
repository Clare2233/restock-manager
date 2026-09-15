/**
 * 通知点击跳转的 web 空实现。
 *
 * 与 `scheduler.web.ts` 同理：web 平台解析到这个文件，
 * `use-notification-responder.ts` 里的 `expo-notifications` 就不会进 bundle。
 */
export function useNotificationResponder(): void {}

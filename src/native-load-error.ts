/** Recognize only a resolver error naming the selected package, not a missing child dependency. */
export function isMissingNativePackage(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND") return false;
  const firstLine = error.message.split("\n", 1)[0];
  const missing = `Cannot find module '${packageName}'`;
  return firstLine === missing || (firstLine?.startsWith(`${missing} from '`) === true && firstLine.endsWith("'"));
}

export function ProcessApprovalDetails({ command, args, cwd, launch = false }: { command: string; args: string[]; cwd?: string | null; launch?: boolean }) {
  return (
    <>
      <div><dt>{launch ? '应用程序' : '执行命令'}</dt><dd className="approval-target">{command}</dd></div>
      <div><dt>命令参数</dt><dd className="approval-target">{args.length ? args.map((arg) => JSON.stringify(arg)).join(' ') : '（无）'}</dd></div>
      <div><dt>工作目录</dt><dd className="approval-target">{cwd || '当前项目目录'}</dd></div>
    </>
  );
}

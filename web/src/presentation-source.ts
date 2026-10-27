export function isSlideDraft(value: string | undefined): boolean {
  return !!value && /第\s*\d{1,2}\s*页\s*[｜|:：]/.test(value);
}

export function shouldAttachPreviousPresentation(message: string, hasFiles: boolean): boolean {
  return !hasFiles && /(?:pptx?|powerpoint|演示文稿|幻灯片)/i.test(message)
    && /(?:这份|刚才|上面|之前)/.test(message) && !isSlideDraft(message);
}

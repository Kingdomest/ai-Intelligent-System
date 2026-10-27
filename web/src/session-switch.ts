export function sessionSwitchReset(): {
  task: null;
  busy: false;
  supplement: '';
  supplementSubmitting: false;
} {
  return {
    task: null,
    busy: false,
    supplement: '',
    supplementSubmitting: false,
  };
}

export interface AccountPanelProps {
  onBusyChange(busy: boolean): void;
  active?: boolean;
}

/** The settings dialog owns the only in-memory copy of a new token. */
export interface TokenSecret {
  value: string;
  name: string;
}

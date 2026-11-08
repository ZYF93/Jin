import { useId, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, RefreshCw, Search } from "lucide-react";
import type { ProviderModel } from "../../shared/ipc";
import { useT } from "../lib/i18n";

/** Searchable remote model picker that always accepts a custom model id. */
export function ModelField({
  models,
  value,
  onChange,
  loading,
  onRefresh,
  onSubmit,
  disabled,
  hint,
}: {
  models: ProviderModel[];
  value: string;
  onChange: (id: string, model?: ProviderModel) => void;
  loading: boolean;
  onRefresh: () => void;
  /** Optional Enter-to-save for compact pickers. */
  onSubmit?: () => void;
  disabled?: boolean;
  hint: ReactNode;
}) {
  const t = useT();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const query = search.trim().toLowerCase();
  const matches = useMemo(
    () => models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query)),
    [models, query],
  );
  const activeIndexSafe = Math.min(activeIndex, Math.max(0, matches.length - 1));
  const active = matches[activeIndexSafe];

  const select = (model: ProviderModel): void => {
    onChange(model.id, model);
    setSearch("");
    setNavigated(false);
    setActiveIndex(models.findIndex((candidate) => candidate.id === model.id));
    setOpen(false);
  };

  const submit = (): void => {
    if (navigated && active) {
      select(active);
      return;
    }
    setOpen(false);
    onSubmit?.();
  };

  return (
    <div>
      <div className="flex gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            size={12}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--faint)]"
          />
          <input
            className="field font-mono-ui min-w-0 pr-7 pl-7"
            role="combobox"
            aria-label={t("chat.model")}
            aria-autocomplete="list"
            aria-expanded={open && models.length > 0}
            aria-controls={listId}
            aria-activedescendant={open && active ? `${listId}-${activeIndexSafe}` : undefined}
            value={value}
            onChange={(event) => {
              const next = event.target.value;
              setSearch(next);
              setNavigated(false);
              onChange(
                next,
                models.find((model) => model.id === next),
              );
              setActiveIndex(0);
              setOpen(true);
            }}
            onFocus={(event) => {
              setOpen(true);
              setSearch("");
              setNavigated(false);
              event.currentTarget.select();
              const selectedIndex = models.findIndex((model) => model.id === value);
              setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
            }}
            onBlur={() => {
              setOpen(false);
              setSearch("");
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && matches.length > 0) {
                event.preventDefault();
                setOpen(true);
                setNavigated(true);
                setActiveIndex((index) =>
                  Math.min(
                    index + (navigated || matches[index]?.id === value.trim() ? 1 : 0),
                    matches.length - 1,
                  ),
                );
              } else if (event.key === "ArrowUp" && matches.length > 0) {
                event.preventDefault();
                setOpen(true);
                setNavigated(true);
                setActiveIndex((index) => Math.max(index - 1, 0));
              } else if (event.key === "Escape") {
                setOpen(false);
              } else if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={t("chat.modelSearchPlaceholder")}
            disabled={disabled}
          />
          {models.length > 0 ? (
            <button
              type="button"
              className="absolute top-1/2 right-1.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-[var(--faint)] hover:bg-[var(--control)] hover:text-[var(--text)]"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (open) {
                  setOpen(false);
                } else {
                  setSearch("");
                  setNavigated(false);
                  const selectedIndex = models.findIndex((model) => model.id === value);
                  setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
                  setOpen(true);
                }
              }}
              disabled={disabled}
              title={t("chat.modelsList")}
              aria-label={t("chat.modelsList")}
              aria-expanded={open}
            >
              <ChevronDown
                size={12}
                className={`transition-transform ${open ? "rotate-180" : ""}`}
              />
            </button>
          ) : null}
          {open && !disabled && models.length > 0 ? (
            <div
              id={listId}
              role="listbox"
              aria-label={t("chat.modelsList")}
              className="absolute top-[calc(100%+4px)] right-0 left-0 z-[80] max-h-56 overflow-y-auto rounded-lg border border-[var(--border-strong)] bg-[var(--panel-solid)] p-1 shadow-xl"
            >
              {matches.length > 0 ? (
                matches.map((model, index) => (
                  <button
                    type="button"
                    id={`${listId}-${index}`}
                    key={model.id}
                    role="option"
                    aria-selected={model.id === value}
                    className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${
                      index === activeIndex
                        ? "bg-[var(--accent-soft)] text-[var(--text)]"
                        : "text-[var(--muted)] hover:bg-[var(--control)]"
                    }`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => select(model)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[10px] font-medium">{model.name}</span>
                      {model.name !== model.id ? (
                        <span className="font-mono-ui mt-0.5 block truncate text-[8px] text-[var(--faint)]">
                          {model.id}
                        </span>
                      ) : null}
                    </span>
                    {model.id === value ? (
                      <span className="mt-0.5 text-[8px] text-[var(--accent)]">✓</span>
                    ) : null}
                  </button>
                ))
              ) : (
                <div className="px-2 py-2 text-[9px] leading-relaxed text-[var(--faint)]">
                  {t("chat.modelNoResults")}
                </div>
              )}
              <div className="border-t border-[var(--border)] px-2 pt-1.5 pb-1 text-[8px] text-[var(--faint)]">
                {t("chat.modelCustomHint")}
              </div>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="icon-btn h-[30px] w-[30px] shrink-0"
          onClick={onRefresh}
          disabled={loading || disabled}
          title={t("chat.modelsRefresh")}
          aria-label={t("chat.modelsRefresh")}
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <div className="hint mt-1">{hint}</div>
    </div>
  );
}

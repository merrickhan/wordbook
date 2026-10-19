import { useId, useState } from 'react';
import { MAX_CATEGORY_NAME_LENGTH, type Category } from './categories';
import { ui, type Locale } from './i18n';

type CreateProps = {
  locale: Locale;
  disabled: boolean;
  onCreate: (name: string) => Promise<boolean>;
};

export function CategoryCreate({ locale, disabled, onCreate }: CreateProps) {
  const text = ui[locale];
  const id = useId();
  const [name, setName] = useState('');
  async function create() {
    if (disabled || !name.trim()) return;
    if (await onCreate(name)) setName('');
  }
  return (
    <div className="category-create">
      <label htmlFor={id}>{text.newCategory}</label>
      <div className="category-name-actions">
        <input id={id} value={name} maxLength={MAX_CATEGORY_NAME_LENGTH} disabled={disabled}
          aria-describedby={`${id}-hint`} onChange={event => setName(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void create();
            }
          }} />
        <button className="secondary" type="button" disabled={disabled || !name.trim()} onClick={() => void create()}>
          {text.createCategory}
        </button>
      </div>
      <p className="field-hint" id={`${id}-hint`}>{text.categoryNameHint}</p>
    </div>
  );
}

type PickerProps = CreateProps & {
  label: string;
  categories: readonly Category[];
  selectedIds: readonly number[];
  onChange: (ids: number[]) => void;
};

export function CategoryPicker({ label, categories, selectedIds, onChange, ...createProps }: PickerProps) {
  const text = ui[createProps.locale];
  const selected = new Set(selectedIds);
  const names = categories.filter(category => selected.has(category.id)).map(category => category.name);
  return (
    <details className="category-picker">
      <summary>{label} <span className="category-count">{text.categoriesSelected(names.length)}</span>
        {names.length > 0 && <span className="category-summary">{names.join(' · ')}</span>}
      </summary>
      <fieldset disabled={createProps.disabled}>
        <legend className="sr-only">{label}</legend>
        <div className="category-options">
          {categories.map(category => (
            <label className="category-option" key={category.id}>
              <input type="checkbox" checked={selected.has(category.id)} onChange={event => {
                const next = new Set(selectedIds);
                if (event.target.checked) next.add(category.id);
                else next.delete(category.id);
                onChange([...next]);
              }} />
              <span>{category.name}</span>
            </label>
          ))}
          {!categories.length && <p className="field-hint">{text.noCategories}</p>}
        </div>
      </fieldset>
      <CategoryCreate {...createProps} />
    </details>
  );
}

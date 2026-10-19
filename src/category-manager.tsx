import { useEffect, useState } from 'react';
import { MAX_CATEGORY_NAME_LENGTH, type Category } from './categories';
import { CategoryCreate } from './category-picker';
import { ui, type Locale } from './i18n';

type Props = {
  categories: readonly Category[];
  locale: Locale;
  disabled: boolean;
  onCreate: (name: string) => Promise<boolean>;
  onRename: (id: number, name: string) => Promise<void>;
  onDelete: (category: Category, trigger: HTMLButtonElement) => Promise<void>;
};

function CategoryName({ category, locale, disabled, onRename, onDelete }: Omit<Props, 'categories' | 'onCreate'> & { category: Category }) {
  const text = ui[locale];
  const [name, setName] = useState(category.name);
  useEffect(() => setName(category.name), [category.name]);
  return (
    <li className="category-name-actions">
      <input aria-label={text.renameCategory(category.name)} value={name} disabled={disabled}
        maxLength={MAX_CATEGORY_NAME_LENGTH} onChange={event => setName(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!disabled && name.trim() && name !== category.name) void onRename(category.id, name);
          }
        }} />
      <button className="secondary" type="button" disabled={disabled || !name.trim() || name === category.name}
        onClick={() => void onRename(category.id, name)}>{text.saveCategoryName}</button>
      <button className="text-button delete-word" type="button" aria-disabled={disabled}
        onClick={event => { if (!disabled) void onDelete(category, event.currentTarget); }}>
        {text.deleteCategory(category.name)}
      </button>
    </li>
  );
}

export function CategoryManager({ categories, onCreate, ...props }: Props) {
  const text = ui[props.locale];
  return (
    <details className="category-manager">
      <summary>{text.manageCategories} <span className="category-count">{categories.length}</span></summary>
      <CategoryCreate locale={props.locale} disabled={props.disabled} onCreate={onCreate} />
      {!categories.length && <p className="field-hint">{text.noCategories}</p>}
      <ul className="category-management-list">
        {categories.map(category => <CategoryName key={category.id} category={category} {...props} />)}
      </ul>
    </details>
  );
}

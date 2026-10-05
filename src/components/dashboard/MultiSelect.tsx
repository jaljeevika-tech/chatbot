import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, X } from 'lucide-react';

interface Props {
  label: string;
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
}

export function MultiSelect({ label, options, selected, onChange }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleOption = (option: string) => {
    if (selected.includes(option)) {
      onChange(selected.filter(item => item !== option));
    } else {
      onChange([...selected, option]);
    }
  };

  const clear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  return (
    <div className="relative flex-1 min-w-[120px]" ref={containerRef}>
      <div
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center justify-between gap-2 bg-white border rounded-xl px-3 py-2 cursor-pointer transition-all hover:bg-gray-50 ${
          isOpen ? 'ring-2 ring-green-500/20 border-green-500' :
          selected.length > 0 ? 'border-green-400 bg-green-50/40' : 'border-gray-200'
        }`}
      >
        <div className="flex-1 min-w-0">
          {selected.length === 0 ? (
            <div>
              <p className="text-[9px] font-black text-gray-400 uppercase tracking-widest leading-none mb-0.5">{label}</p>
              <p className="text-xs text-gray-400 font-medium">All</p>
            </div>
          ) : (
            <div>
              <p className="text-[9px] font-black text-green-600 uppercase tracking-widest leading-none mb-0.5">{label}</p>
              <div className="flex items-center gap-1 overflow-hidden">
                <span className="bg-green-100 text-green-700 text-[9px] px-1.5 py-0.5 rounded-full font-black shrink-0">
                  {selected.length}
                </span>
                <span className="text-xs text-green-800 font-bold truncate">
                  {selected.length === 1 ? selected[0] : `${selected[0]}…`}
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center shrink-0 gap-1">
          {selected.length > 0 && (
            <X
              className="w-3 h-3 text-gray-300 hover:text-red-500 transition-colors"
              onClick={clear}
            />
          )}
          <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-100 rounded-2xl shadow-2xl z-[200] overflow-hidden">
          <div className="px-3 pt-2.5 pb-1 border-b border-gray-50">
            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{label}</p>
          </div>
          <div className="max-h-56 overflow-y-auto py-1.5 custom-scrollbar">
            {options.length === 0 ? (
              <div className="px-4 py-3 text-xs text-gray-400 text-center italic">No options</div>
            ) : (
              options.map(option => (
                <div
                  key={option}
                  onClick={() => toggleOption(option)}
                  className="flex items-center justify-between px-4 py-2.5 hover:bg-green-50 cursor-pointer transition-colors group"
                >
                  <span className={`text-xs font-medium leading-tight ${selected.includes(option) ? 'text-green-700 font-bold' : 'text-gray-600 group-hover:text-green-600'}`}>
                    {option}
                  </span>
                  {selected.includes(option) && (
                    <Check className="w-3 h-3 text-green-600 shrink-0" />
                  )}
                </div>
              ))
            )}
          </div>
          {options.length > 0 && (
            <div className="border-t border-gray-50 bg-gray-50/50 px-3 py-2 flex items-center justify-between">
              <button
                onClick={e => { e.stopPropagation(); onChange([...options]); }}
                disabled={selected.length === options.length}
                className="text-[10px] font-black text-green-600 hover:text-green-700 uppercase tracking-widest transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-green-600"
              >
                Select All
              </button>
              {selected.length > 0 && (
                <button
                  onClick={e => { e.stopPropagation(); onChange([]); }}
                  className="text-[10px] font-black text-gray-400 hover:text-red-500 uppercase tracking-widest transition-colors"
                >
                  Clear All
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

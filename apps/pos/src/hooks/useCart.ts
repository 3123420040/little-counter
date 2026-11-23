import { useReducer, useCallback } from "react";

export interface CartItemVisionContext {
  scanEventId: string;
  detectionId?: string;
  correctionId?: string;
  objectId?: string;
  candidateSource: "ai_candidate" | "manual_search_after_scan";
  provider: string;
  providerCandidateRank?: number;
  providerConfidence?: number;
  providerProductRef?: string;
  providerImageRef?: string;
}

export interface CartItem {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  stockLevel: number;
  visionContexts?: CartItemVisionContext[];
}

interface CartState {
  items: CartItem[];
  selectedIndex: number | null;
}

type CartAction =
  | { type: "ADD_ITEM"; item: CartItem }
  | { type: "REMOVE_ITEM"; variantId: string }
  | { type: "UPDATE_QTY"; variantId: string; quantity: number }
  | { type: "SELECT_ITEM"; index: number | null }
  | { type: "CLEAR" };

function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case "ADD_ITEM": {
      const existingIdx = state.items.findIndex(i => i.variantId === action.item.variantId);
      if (existingIdx >= 0) {
        const updated = [...state.items];
        const current = updated[existingIdx];
        updated[existingIdx] = {
          ...current,
          quantity: current.quantity + action.item.quantity,
          visionContexts: [
            ...(current.visionContexts || []),
            ...(action.item.visionContexts || []),
          ],
        };
        return { ...state, items: updated, selectedIndex: existingIdx };
      }
      return { ...state, items: [...state.items, action.item], selectedIndex: state.items.length };
    }
    case "REMOVE_ITEM":
      return { ...state, items: state.items.filter(i => i.variantId !== action.variantId), selectedIndex: null };
    case "UPDATE_QTY": {
      if (action.quantity <= 0) return { ...state, items: state.items.filter(i => i.variantId !== action.variantId) };
      return {
        ...state,
        items: state.items.map(i =>
          i.variantId === action.variantId
            ? {
                ...i,
                quantity: action.quantity,
                visionContexts: i.visionContexts ? i.visionContexts.slice(0, action.quantity) : undefined,
              }
            : i
        ),
      };
    }
    case "SELECT_ITEM":
      return { ...state, selectedIndex: action.index };
    case "CLEAR":
      return { items: [], selectedIndex: null };
    default:
      return state;
  }
}

const initialState: CartState = { items: [], selectedIndex: null };

export function useCart() {
  const [state, dispatch] = useReducer(cartReducer, initialState);

  const addItem = useCallback((item: CartItem) => dispatch({ type: "ADD_ITEM", item }), []);
  const removeItem = useCallback((variantId: string) => dispatch({ type: "REMOVE_ITEM", variantId }), []);
  const updateQty = useCallback((variantId: string, quantity: number) => dispatch({ type: "UPDATE_QTY", variantId, quantity }), []);
  const selectItem = useCallback((index: number | null) => dispatch({ type: "SELECT_ITEM", index }), []);
  const clearCart = useCallback(() => dispatch({ type: "CLEAR" }), []);

  const subtotal = state.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const itemCount = state.items.reduce((sum, i) => sum + i.quantity, 0);

  return { items: state.items, selectedIndex: state.selectedIndex, subtotal, itemCount, addItem, removeItem, updateQty, selectItem, clearCart };
}

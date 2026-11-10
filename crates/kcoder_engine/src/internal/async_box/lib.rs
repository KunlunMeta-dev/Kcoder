//! Keep concrete async-trait unsizing out of the owning method's MIR.

use proc_macro::TokenStream;
use quote::quote;
use syn::{Expr, GenericArgument, ImplItem, ItemImpl, PathArguments, ReturnType, Stmt, Type};

/// Apply after `async_trait` to reuse the existing generic future coercion.
#[proc_macro_attribute]
pub fn shared(arguments: TokenStream, item: TokenStream) -> TokenStream {
    if !arguments.is_empty() {
        return syn::Error::new(proc_macro2::Span::call_site(), "shared takes no arguments")
            .to_compile_error()
            .into();
    }
    let mut implementation = syn::parse_macro_input!(item as ItemImpl);
    match rewrite(&mut implementation) {
        Ok(_) => quote!(#implementation).into(),
        Err(error) => error.to_compile_error().into(),
    }
}

fn rewrite(implementation: &mut ItemImpl) -> syn::Result<usize> {
    let mut changed = 0;
    for item in &mut implementation.items {
        let ImplItem::Fn(method) = item else {
            continue;
        };
        if method.sig.asyncness.is_some() {
            return Err(syn::Error::new_spanned(
                &method.sig,
                "place #[kcoder_async_box::shared] after #[async_trait]",
            ));
        }
        let ReturnType::Type(_, result) = &method.sig.output else {
            continue;
        };
        let Some(bounds) = future_bounds(result) else {
            continue;
        };
        let send = bounds.iter().any(|bound| {
            matches!(bound, syn::TypeParamBound::Trait(bound) if bound.path.is_ident("Send")
                || bound.path.segments.last().is_some_and(|segment| segment.ident == "Send"))
        });
        let Some(Stmt::Expr(Expr::Call(call), None)) = method.block.stmts.last_mut() else {
            continue;
        };
        let Expr::Path(callee) = call.func.as_ref() else {
            continue;
        };
        let mut segments = callee.path.segments.iter().rev();
        if segments.next().is_none_or(|segment| segment.ident != "pin")
            || segments.next().is_none_or(|segment| segment.ident != "Box")
            || call.args.len() != 1
            || !matches!(call.args.first(), Some(Expr::Async(_)))
        {
            continue;
        }
        // Preserve the future expression, method signature, and all nested casts.
        *call.func = if send {
            syn::parse_quote!(::futures::FutureExt::boxed)
        } else {
            syn::parse_quote!(::futures::FutureExt::boxed_local)
        };
        changed += 1;
    }
    if changed == 0 {
        return Err(syn::Error::new_spanned(
            &implementation.self_ty,
            "shared requires an expanded async_trait impl with a boxed async body",
        ));
    }
    Ok(changed)
}

fn future_bounds(
    ty: &Type,
) -> Option<&syn::punctuated::Punctuated<syn::TypeParamBound, syn::Token![+]>> {
    match ty {
        Type::Path(ty) => {
            let segment = ty.path.segments.last()?;
            if segment.ident != "Pin" && segment.ident != "Box" {
                return None;
            }
            let PathArguments::AngleBracketed(arguments) = &segment.arguments else {
                return None;
            };
            let Some(GenericArgument::Type(inner)) = arguments.args.first() else {
                return None;
            };
            future_bounds(inner)
        }
        Type::TraitObject(ty)
            if ty.bounds.iter().any(|bound| {
                matches!(bound, syn::TypeParamBound::Trait(bound)
                    if bound.path.segments.last().is_some_and(|segment| segment.ident == "Future"))
            }) =>
        {
            Some(&ty.bounds)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_signature_and_nested_pin_expression() {
        let mut item: ItemImpl = syn::parse_quote! {
            impl Service for Host {
                fn query<'a>(&'a self, input: &'a str)
                    -> Pin<Box<dyn Future<Output = &'a str> + Send + 'a>> {
                    Box::pin(async move {
                        let nested = Box::pin(std::future::ready(input));
                        nested.await
                    })
                }
                fn name(&self) -> &str { "host" }
            }
        };
        let original = item.clone();
        assert_eq!(rewrite(&mut item).unwrap(), 1);
        let ImplItem::Fn(before) = &original.items[0] else {
            panic!()
        };
        let ImplItem::Fn(after) = &item.items[0] else {
            panic!()
        };
        let before_signature = &before.sig;
        let after_signature = &after.sig;
        assert_eq!(
            quote!(#before_signature).to_string(),
            quote!(#after_signature).to_string()
        );
        let Stmt::Expr(Expr::Call(before_call), _) = &before.block.stmts[0] else {
            panic!()
        };
        let Stmt::Expr(Expr::Call(after_call), _) = &after.block.stmts[0] else {
            panic!()
        };
        let before_arguments = &before_call.args;
        let after_arguments = &after_call.args;
        assert_eq!(
            quote!(#before_arguments).to_string(),
            quote!(#after_arguments).to_string()
        );
        let untouched_before = &original.items[1];
        let untouched_after = &item.items[1];
        assert_eq!(
            quote!(#untouched_before).to_string(),
            quote!(#untouched_after).to_string()
        );
    }

    #[test]
    fn rejects_unexpanded_or_unrecognized_input() {
        let mut early: ItemImpl = syn::parse_quote! {
            impl Service for Host { async fn query(&self) {} }
        };
        assert!(rewrite(&mut early).is_err());
        let mut unrelated: ItemImpl = syn::parse_quote! {
            impl Host { fn unrelated(&self) {} }
        };
        assert!(rewrite(&mut unrelated).is_err());
    }
}

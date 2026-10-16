Here's the full message for the developer, with nothing to fill in:

Meta Pixel – please add these 3 things
1. Paste this inside <head> of index.html (once, for all pages):
<!-- Meta Pixel Code -->  
<script>  
!function(f,b,e,v,n,t,s)  
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?  
n.callMethod.apply(n,arguments):n.queue.push(arguments)};  
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';  
n.queue=[];t=b.createElement(e);t.async=!0;  
t.src=v;s=b.getElementsByTagName(e)[0];  
s.parentNode.insertBefore(t,s)}(window, document,'script',  
'https://connect.facebook.net/en_US/fbevents.js');  
fbq('init', '1766533370600791');  
fbq('track', 'PageView');  
</script>  
<!-- End Meta Pixel Code -->  

2. Add to cart: add this line where an item is added to the cart successfully (main Add to cart button and the mobile bottom-bar button):
window.fbq && fbq('track', 'AddToCart');  

3. Purchase: add this line where an order is placed successfully (online payment and cash on delivery), just before going to /myorders:
window.fbq && fbq('track', 'Purchase', { value: 0, currency: 'INR' });  

⚠️ Please do not put it on the /myorders page itself, or it will count again every time a customer opens My Orders.
Use the code exactly as written, with no changes needed. 


Here's where each one goes, in simple terms:
#
Code
Where in the website
When it runs
1
Main pixel code (the long block)
The index.html file, inside the <head> section near the top. Every website has this file.
On every page, automatically
2
AddToCart line
In the code behind the "Add to cart" button, both the big button on the page and the one in the mobile bottom bar
Each time someone taps Add to cart
3
Purchase line
In the code behind the "Place order" / "Confirm order" button on the checkout page, in the part that runs after the order is saved successfully
Each time an order is placed


